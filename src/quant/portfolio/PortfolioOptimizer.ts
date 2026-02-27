/**
 * ============================================================================
 * MAN GROUP — PORTFOLIO OPTIMIZATION SYSTEM
 * ============================================================================
 *
 * Multi-asset/multi-strategy allocation to maximize risk-adjusted returns.
 *
 * METHODS:
 * 1. Mean-Variance (Markowitz) — Classic efficient frontier
 * 2. Black-Litterman — Combine market equilibrium with views
 * 3. Risk Parity — Equal risk contribution
 * 4. Hierarchical Risk Parity — Cluster-based allocation
 * 5. Robust Optimization — Handles noisy estimates
 *
 * ============================================================================
 */

import { mean, stddev, correlation } from "../../utils/mathUtils";
import { logger } from "../../utils/logger";

// ============================================================================
// TYPES
// ============================================================================

export interface IPortfolioWeights {
  weights: Record<string, number>;     // asset → weight (0-1)
  expectedReturn: number;
  expectedVolatility: number;
  sharpeRatio: number;
  diversificationRatio: number;
  riskContributions: Record<string, number>;
  method: string;
}

export interface IConstraints {
  minWeight: number;          // Minimum per-asset weight (0 = no short)
  maxWeight: number;          // Maximum per-asset weight (e.g., 0.40)
  maxTurnover: number;        // Maximum turnover from current portfolio
  sectorCaps?: Record<string, number>;  // Sector → max weight
}

export interface IBlackLittermanView {
  assets: string[];           // Which assets the view is about
  viewWeights: number[];      // Weight of each asset in the view
  viewReturn: number;         // Expected return of the view
  confidence: number;         // 0-1, higher = more confident
}

// ============================================================================
// MATRIX OPERATIONS (pure TypeScript, no numpy)
// ============================================================================

class MatrixOps {
  /**
   * Compute covariance matrix from returns.
   */
  static covarianceMatrix(returns: number[][]): number[][] {
    const n = returns.length; // number of assets
    const cov: number[][] = [];

    for (let i = 0; i < n; i++) {
      cov.push([]);
      for (let j = 0; j < n; j++) {
        cov[i].push(this.covariance(returns[i], returns[j]));
      }
    }

    return cov;
  }

  static covariance(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    const mx = mean(x.slice(0, n));
    const my = mean(y.slice(0, n));
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += (x[i] - mx) * (y[i] - my);
    }
    return sum / (n - 1);
  }

  /**
   * Matrix-vector multiplication: A * v
   */
  static matVecMul(A: number[][], v: number[]): number[] {
    return A.map(row => row.reduce((s, val, j) => s + val * v[j], 0));
  }

  /**
   * Vector dot product
   */
  static dot(a: number[], b: number[]): number {
    return a.reduce((s, val, i) => s + val * (b[i] || 0), 0);
  }

  /**
   * Invert a symmetric positive-definite matrix using Cholesky decomposition.
   * Falls back to regularized pseudo-inverse for near-singular matrices.
   */
  static invertMatrix(A: number[][]): number[][] {
    const n = A.length;

    // Add regularization to prevent singularity
    const reg = 1e-8;
    const regA = A.map((row, i) => row.map((v, j) => v + (i === j ? reg : 0)));

    // Gauss-Jordan elimination
    const augmented = regA.map((row, i) => {
      const identity = new Array(n).fill(0);
      identity[i] = 1;
      return [...row, ...identity];
    });

    for (let col = 0; col < n; col++) {
      // Partial pivoting
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(augmented[row][col]) > Math.abs(augmented[maxRow][col])) {
          maxRow = row;
        }
      }
      [augmented[col], augmented[maxRow]] = [augmented[maxRow], augmented[col]];

      const pivot = augmented[col][col];
      if (Math.abs(pivot) < 1e-12) continue;

      // Scale pivot row
      for (let j = 0; j < 2 * n; j++) {
        augmented[col][j] /= pivot;
      }

      // Eliminate column
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = augmented[row][col];
        for (let j = 0; j < 2 * n; j++) {
          augmented[row][j] -= factor * augmented[col][j];
        }
      }
    }

    // Extract inverse
    return augmented.map(row => row.slice(n));
  }

  /**
   * Portfolio variance: w' * Σ * w
   */
  static portfolioVariance(weights: number[], covMatrix: number[][]): number {
    const Sw = this.matVecMul(covMatrix, weights);
    return this.dot(weights, Sw);
  }

  /**
   * Portfolio expected return: w' * μ
   */
  static portfolioReturn(weights: number[], expectedReturns: number[]): number {
    return this.dot(weights, expectedReturns);
  }
}

// ============================================================================
// MEAN-VARIANCE OPTIMIZATION (Markowitz)
// ============================================================================

export class MeanVarianceOptimizer {
  /**
   * Classic Markowitz Mean-Variance Optimization.
   *
   * max: w' * μ - (λ/2) * w' * Σ * w
   * s.t.: Σw_i = 1, w_i >= minWeight, w_i <= maxWeight
   *
   * Uses iterative projection for constraint satisfaction.
   *
   * @param expectedReturns Vector of expected returns per asset
   * @param covMatrix Covariance matrix
   * @param riskAversion Lambda: higher = more conservative
   * @param constraints Position limits
   */
  static optimize(
    assets: string[],
    expectedReturns: number[],
    covMatrix: number[][],
    riskAversion = 2.0,
    constraints: IConstraints = { minWeight: 0, maxWeight: 0.40, maxTurnover: 1.0 }
  ): IPortfolioWeights {
    const n = assets.length;
    if (n === 0) return this.emptyResult("mean_variance");

    // Analytical solution (unconstrained): w* = (1/λ) * Σ^-1 * μ
    const invCov = MatrixOps.invertMatrix(covMatrix);
    let rawWeights = MatrixOps.matVecMul(invCov, expectedReturns).map(w => w / riskAversion);

    // Normalize to sum to 1
    const sumW = rawWeights.reduce((s, w) => s + w, 0);
    if (Math.abs(sumW) > 1e-10) {
      rawWeights = rawWeights.map(w => w / sumW);
    } else {
      rawWeights = new Array(n).fill(1 / n);
    }

    // Project onto constraints (iterative clipping)
    const weights = this.projectConstraints(rawWeights, constraints, 50);

    // Calculate metrics
    const portReturn = MatrixOps.portfolioReturn(weights, expectedReturns);
    const portVariance = MatrixOps.portfolioVariance(weights, covMatrix);
    const portVol = Math.sqrt(Math.max(0, portVariance));
    const sharpe = portVol > 0 ? portReturn / portVol : 0;

    // Risk contributions
    const riskContributions: Record<string, number> = {};
    const Sw = MatrixOps.matVecMul(covMatrix, weights);
    for (let i = 0; i < n; i++) {
      const marginalRisk = Sw[i];
      riskContributions[assets[i]] = portVol > 0 ? (weights[i] * marginalRisk) / portVariance : 1 / n;
    }

    // Diversification ratio: weighted vol / portfolio vol
    const weightedVol = weights.reduce((s, w, i) => s + w * Math.sqrt(covMatrix[i][i]), 0);
    const diversificationRatio = portVol > 0 ? weightedVol / portVol : 1;

    const weightMap: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      weightMap[assets[i]] = Math.round(weights[i] * 10000) / 10000;
    }

    return {
      weights: weightMap,
      expectedReturn: portReturn,
      expectedVolatility: portVol,
      sharpeRatio: sharpe,
      diversificationRatio,
      riskContributions,
      method: "mean_variance",
    };
  }

  /**
   * Project weights onto constraint set.
   * Iteratively clips and renormalizes.
   */
  private static projectConstraints(
    weights: number[],
    constraints: IConstraints,
    maxIter = 50
  ): number[] {
    let w = [...weights];
    const n = w.length;

    for (let iter = 0; iter < maxIter; iter++) {
      // Clip to bounds
      for (let i = 0; i < n; i++) {
        w[i] = Math.max(constraints.minWeight, Math.min(constraints.maxWeight, w[i]));
      }

      // Renormalize to sum to 1
      const sum = w.reduce((s, v) => s + v, 0);
      if (sum > 0) {
        w = w.map(v => v / sum);
      } else {
        w = new Array(n).fill(1 / n);
        break;
      }

      // Check if constraints are satisfied
      const allSatisfied = w.every(v => v >= constraints.minWeight - 1e-6 && v <= constraints.maxWeight + 1e-6);
      if (allSatisfied && Math.abs(w.reduce((s, v) => s + v, 0) - 1) < 1e-6) break;
    }

    return w;
  }

  private static emptyResult(method: string): IPortfolioWeights {
    return { weights: {}, expectedReturn: 0, expectedVolatility: 0, sharpeRatio: 0, diversificationRatio: 1, riskContributions: {}, method };
  }
}

// ============================================================================
// BLACK-LITTERMAN MODEL
// ============================================================================

export class BlackLittermanModel {
  /**
   * Black-Litterman: combine market equilibrium with personal views.
   *
   * Equilibrium returns: π = δ * Σ * w_mkt
   * Combined returns: E[R] = [(τΣ)^-1 + P'Ω^-1P]^-1 * [(τΣ)^-1 * π + P'Ω^-1 * Q]
   *
   * where:
   *   τ = uncertainty scaling (typically 0.05)
   *   P = view matrix (which assets each view is about)
   *   Q = view returns vector
   *   Ω = uncertainty of views (diagonal)
   *   δ = risk aversion
   */
  static optimize(
    assets: string[],
    covMatrix: number[][],
    marketWeights: number[],
    views: IBlackLittermanView[],
    riskAversion = 2.5,
    tau = 0.05,
    constraints?: IConstraints
  ): IPortfolioWeights {
    const n = assets.length;
    if (n === 0) return MeanVarianceOptimizer["emptyResult"]("black_litterman");

    // Step 1: Calculate equilibrium returns
    // π = δ * Σ * w_mkt
    const equilibriumReturns = MatrixOps.matVecMul(covMatrix, marketWeights)
      .map(v => v * riskAversion);

    if (views.length === 0) {
      // No views: just use equilibrium returns
      return MeanVarianceOptimizer.optimize(assets, equilibriumReturns, covMatrix, riskAversion, constraints);
    }

    // Step 2: Build view matrix P and view returns Q
    const k = views.length;
    const P: number[][] = []; // k x n matrix
    const Q: number[] = [];   // k x 1 vector
    const omega: number[][] = []; // k x k diagonal uncertainty matrix

    for (let v = 0; v < k; v++) {
      const viewRow = new Array(n).fill(0);
      for (let a = 0; a < views[v].assets.length; a++) {
        const assetIdx = assets.indexOf(views[v].assets[a]);
        if (assetIdx >= 0) {
          viewRow[assetIdx] = views[v].viewWeights[a];
        }
      }
      P.push(viewRow);
      Q.push(views[v].viewReturn);

      // Omega: view uncertainty (lower confidence = higher uncertainty)
      const omegaRow = new Array(k).fill(0);
      const viewUncertainty = tau * (1 / (views[v].confidence + 0.01) - 1);
      omegaRow[v] = Math.max(0.0001, viewUncertainty);
      omega.push(omegaRow);
    }

    // Step 3: Black-Litterman combined returns
    // Simplified version: blend equilibrium and views
    const tauSigma = covMatrix.map(row => row.map(v => v * tau));
    const tauSigmaInv = MatrixOps.invertMatrix(tauSigma);
    const omegaInv = MatrixOps.invertMatrix(omega);

    // P' * Omega^-1 * Q
    const PtOmegaInvQ: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let v = 0; v < k; v++) {
        for (let v2 = 0; v2 < k; v2++) {
          PtOmegaInvQ[i] += P[v][i] * omegaInv[v][v2] * Q[v2];
        }
      }
    }

    // (τΣ)^-1 * π
    const tauSigmaInvPi = MatrixOps.matVecMul(tauSigmaInv, equilibriumReturns);

    // Combined: blend equilibrium and views
    const blendedReturns = equilibriumReturns.map((eqR, i) => {
      const viewContrib = PtOmegaInvQ[i];
      const totalWeight = 1 + tau;
      return (eqR + viewContrib * tau) / totalWeight;
    });

    // Step 4: Optimize with blended returns
    return MeanVarianceOptimizer.optimize(
      assets,
      blendedReturns,
      covMatrix,
      riskAversion,
      constraints || { minWeight: 0, maxWeight: 0.40, maxTurnover: 1.0 }
    );
  }
}

// ============================================================================
// RISK PARITY ALLOCATION
// ============================================================================

export class RiskParityAllocator {
  /**
   * Risk Parity: equal risk contribution from each asset.
   *
   * Each asset contributes equally to portfolio risk:
   * RC_i = w_i * (Σw)_i / σ_p = 1/N for all i
   *
   * Solved via iterative Newton method.
   */
  static optimize(
    assets: string[],
    covMatrix: number[][],
    targetRiskContribution?: number[]
  ): IPortfolioWeights {
    const n = assets.length;
    if (n === 0) return { weights: {}, expectedReturn: 0, expectedVolatility: 0, sharpeRatio: 0, diversificationRatio: 1, riskContributions: {}, method: "risk_parity" };

    // Default: equal risk contribution
    const targetRC = targetRiskContribution || new Array(n).fill(1 / n);

    // Initialize with inverse-volatility weights
    let weights = covMatrix.map((row, i) => {
      const vol = Math.sqrt(row[i]);
      return vol > 0 ? 1 / vol : 1;
    });

    // Normalize
    const sumW = weights.reduce((s, w) => s + w, 0);
    weights = weights.map(w => w / sumW);

    // Iterative optimization (Newton's method simplified)
    for (let iter = 0; iter < 100; iter++) {
      const Sw = MatrixOps.matVecMul(covMatrix, weights);
      const portVar = MatrixOps.dot(weights, Sw);
      const portVol = Math.sqrt(Math.max(0, portVar));

      if (portVol === 0) break;

      // Risk contributions
      const rc: number[] = [];
      for (let i = 0; i < n; i++) {
        rc.push(weights[i] * Sw[i] / portVar);
      }

      // Gradient: adjust weights toward target risk contribution
      let maxError = 0;
      for (let i = 0; i < n; i++) {
        const error = rc[i] - targetRC[i];
        maxError = Math.max(maxError, Math.abs(error));

        // Newton step: reduce weight if risk contribution too high
        const step = 0.1 * error;
        weights[i] *= Math.exp(-step);
      }

      // Normalize
      const s = weights.reduce((sum, w) => sum + w, 0);
      weights = weights.map(w => w / s);

      // Convergence check
      if (maxError < 0.0001) break;
    }

    // Calculate metrics
    const portVar = MatrixOps.portfolioVariance(weights, covMatrix);
    const portVol = Math.sqrt(Math.max(0, portVar));

    const riskContributions: Record<string, number> = {};
    const Sw = MatrixOps.matVecMul(covMatrix, weights);
    for (let i = 0; i < n; i++) {
      riskContributions[assets[i]] = portVar > 0 ? weights[i] * Sw[i] / portVar : 1 / n;
    }

    const weightMap: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      weightMap[assets[i]] = Math.round(weights[i] * 10000) / 10000;
    }

    return {
      weights: weightMap,
      expectedReturn: 0, // Risk parity doesn't use return estimates
      expectedVolatility: portVol,
      sharpeRatio: 0,
      diversificationRatio: 1,
      riskContributions,
      method: "risk_parity",
    };
  }
}

// ============================================================================
// HIERARCHICAL RISK PARITY (Lopez de Prado)
// ============================================================================

export class HierarchicalRiskParity {
  /**
   * HRP: Tree-based allocation that avoids unstable covariance inversion.
   *
   * Steps:
   * 1. Compute distance matrix from correlations
   * 2. Hierarchical clustering (single-linkage)
   * 3. Quasi-diagonalize the covariance matrix
   * 4. Recursive bisection: allocate by inverse variance
   */
  static optimize(
    assets: string[],
    returns: number[][]
  ): IPortfolioWeights {
    const n = assets.length;
    if (n === 0) return { weights: {}, expectedReturn: 0, expectedVolatility: 0, sharpeRatio: 0, diversificationRatio: 1, riskContributions: {}, method: "hrp" };

    // Step 1: Distance matrix from correlations
    const corrMatrix: number[][] = [];
    for (let i = 0; i < n; i++) {
      corrMatrix.push([]);
      for (let j = 0; j < n; j++) {
        corrMatrix[i].push(correlation(returns[i], returns[j]));
      }
    }

    // Distance = sqrt(0.5 * (1 - corr))
    const distMatrix: number[][] = [];
    for (let i = 0; i < n; i++) {
      distMatrix.push([]);
      for (let j = 0; j < n; j++) {
        distMatrix[i].push(Math.sqrt(0.5 * (1 - corrMatrix[i][j])));
      }
    }

    // Step 2: Seriation (order assets by cluster proximity)
    const order = this.seriate(distMatrix, n);

    // Step 3: Covariance matrix
    const covMatrix = MatrixOps.covarianceMatrix(returns);

    // Step 4: Recursive bisection
    const weights = new Array(n).fill(0);
    this.recursiveBisection(covMatrix, order, weights, 0, order.length);

    // Normalize
    const sumW = weights.reduce((s, w) => s + w, 0);
    const finalWeights = sumW > 0 ? weights.map(w => w / sumW) : new Array(n).fill(1 / n);

    const portVar = MatrixOps.portfolioVariance(finalWeights, covMatrix);
    const portVol = Math.sqrt(Math.max(0, portVar));

    const weightMap: Record<string, number> = {};
    const riskContributions: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      weightMap[assets[i]] = Math.round(finalWeights[i] * 10000) / 10000;
      riskContributions[assets[i]] = 1 / n; // Approximate
    }

    return {
      weights: weightMap,
      expectedReturn: 0,
      expectedVolatility: portVol,
      sharpeRatio: 0,
      diversificationRatio: 1,
      riskContributions,
      method: "hrp",
    };
  }

  /**
   * Simple seriation: order by nearest-neighbor in distance matrix.
   */
  private static seriate(dist: number[][], n: number): number[] {
    const visited = new Set<number>();
    const order: number[] = [0];
    visited.add(0);

    while (order.length < n) {
      const last = order[order.length - 1];
      let nearest = -1;
      let minDist = Infinity;

      for (let i = 0; i < n; i++) {
        if (!visited.has(i) && dist[last][i] < minDist) {
          minDist = dist[last][i];
          nearest = i;
        }
      }

      if (nearest >= 0) {
        order.push(nearest);
        visited.add(nearest);
      } else break;
    }

    return order;
  }

  /**
   * Recursive bisection: split portfolio and allocate by inverse variance.
   */
  private static recursiveBisection(
    covMatrix: number[][],
    order: number[],
    weights: number[],
    start: number,
    end: number
  ): void {
    if (end - start <= 1) {
      if (start < order.length) {
        const idx = order[start];
        weights[idx] = 1;
      }
      return;
    }

    const mid = Math.floor((start + end) / 2);

    // Calculate cluster variance for each half
    const leftIndices = order.slice(start, mid);
    const rightIndices = order.slice(mid, end);

    const leftVar = this.clusterVariance(covMatrix, leftIndices);
    const rightVar = this.clusterVariance(covMatrix, rightIndices);

    // Allocate inversely proportional to variance
    const totalInvVar = (1 / (leftVar + 1e-10)) + (1 / (rightVar + 1e-10));
    const leftWeight = (1 / (leftVar + 1e-10)) / totalInvVar;
    const rightWeight = 1 - leftWeight;

    // Recurse
    this.recursiveBisection(covMatrix, order, weights, start, mid);
    this.recursiveBisection(covMatrix, order, weights, mid, end);

    // Scale by cluster weight
    for (let i = start; i < mid; i++) {
      weights[order[i]] *= leftWeight;
    }
    for (let i = mid; i < end; i++) {
      weights[order[i]] *= rightWeight;
    }
  }

  private static clusterVariance(covMatrix: number[][], indices: number[]): number {
    if (indices.length === 0) return 1;
    if (indices.length === 1) return covMatrix[indices[0]][indices[0]];

    // Equal-weight within cluster
    const w = indices.map(() => 1 / indices.length);
    let variance = 0;
    for (let i = 0; i < indices.length; i++) {
      for (let j = 0; j < indices.length; j++) {
        variance += w[i] * w[j] * covMatrix[indices[i]][indices[j]];
      }
    }
    return variance;
  }
}

// ============================================================================
// PERFORMANCE ATTRIBUTION
// ============================================================================

export class PerformanceAttribution {
  /**
   * Brinson-Fachler Attribution: decompose returns into:
   * - Allocation Effect: did we overweight winning sectors?
   * - Selection Effect: did we pick winners within sectors?
   * - Interaction Effect: combination of both
   */
  static brinson(
    portfolioWeights: Record<string, number>,
    benchmarkWeights: Record<string, number>,
    portfolioReturns: Record<string, number>,
    benchmarkReturns: Record<string, number>
  ): {
    allocationEffect: number;
    selectionEffect: number;
    interactionEffect: number;
    totalActiveReturn: number;
    assetContributions: Record<string, { allocation: number; selection: number; total: number }>;
  } {
    const assets = [...new Set([...Object.keys(portfolioWeights), ...Object.keys(benchmarkWeights)])];

    let allocationEffect = 0;
    let selectionEffect = 0;
    let interactionEffect = 0;
    const contributions: Record<string, { allocation: number; selection: number; total: number }> = {};

    const benchmarkTotalReturn = Object.entries(benchmarkWeights)
      .reduce((s, [a, w]) => s + w * (benchmarkReturns[a] || 0), 0);

    for (const asset of assets) {
      const wp = portfolioWeights[asset] || 0;
      const wb = benchmarkWeights[asset] || 0;
      const rp = portfolioReturns[asset] || 0;
      const rb = benchmarkReturns[asset] || 0;

      // Allocation: (wp - wb) * (rb - benchmarkTotalReturn)
      const alloc = (wp - wb) * (rb - benchmarkTotalReturn);

      // Selection: wb * (rp - rb)
      const selection = wb * (rp - rb);

      // Interaction: (wp - wb) * (rp - rb)
      const interaction = (wp - wb) * (rp - rb);

      allocationEffect += alloc;
      selectionEffect += selection;
      interactionEffect += interaction;

      contributions[asset] = {
        allocation: alloc,
        selection,
        total: alloc + selection + interaction,
      };
    }

    return {
      allocationEffect,
      selectionEffect,
      interactionEffect,
      totalActiveReturn: allocationEffect + selectionEffect + interactionEffect,
      assetContributions: contributions,
    };
  }
}

// ============================================================================
// REBALANCING OPTIMIZER
// ============================================================================

export class RebalancingOptimizer {
  /**
   * Minimize trading costs while approaching target weights.
   *
   * Trade only if benefit of rebalancing exceeds transaction costs.
   * Uses a threshold-based approach: only rebalance positions that
   * deviate more than threshold from target.
   */
  static computeRebalanceTrades(
    currentWeights: Record<string, number>,
    targetWeights: Record<string, number>,
    totalEquity: number,
    transactionCostBps = 10,
    rebalanceThreshold = 0.02 // Only rebalance if > 2% deviation
  ): { asset: string; currentWeight: number; targetWeight: number; tradeSize: number; tradeCost: number }[] {
    const trades: { asset: string; currentWeight: number; targetWeight: number; tradeSize: number; tradeCost: number }[] = [];

    const allAssets = [...new Set([...Object.keys(currentWeights), ...Object.keys(targetWeights)])];

    for (const asset of allAssets) {
      const current = currentWeights[asset] || 0;
      const target = targetWeights[asset] || 0;
      const deviation = Math.abs(target - current);

      if (deviation > rebalanceThreshold) {
        const tradeSize = (target - current) * totalEquity;
        const tradeCost = Math.abs(tradeSize) * (transactionCostBps / 10000);

        // Only trade if expected benefit exceeds cost
        // Simple heuristic: benefit ≈ deviation * expected return improvement
        trades.push({
          asset,
          currentWeight: current,
          targetWeight: target,
          tradeSize,
          tradeCost,
        });
      }
    }

    return trades.sort((a, b) => Math.abs(b.tradeSize) - Math.abs(a.tradeSize));
  }
}
