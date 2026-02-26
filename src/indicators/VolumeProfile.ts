import { EMA } from "./EMA";

export interface VolumeAnalysis {
  currentVolume: number;
  emaVolume: number;
  volumeRatio: number; // current / ema
  isSpike: boolean;
  spikeMultiplier: number;
}

export class VolumeProfile {
  /**
   * Calculate volume EMA and detect spikes.
   */
  static analyze(
    volumes: number[],
    emaPeriod: number = 20,
    spikeThreshold: number = 5
  ): VolumeAnalysis {
    if (volumes.length === 0) {
      return {
        currentVolume: 0,
        emaVolume: 0,
        volumeRatio: 0,
        isSpike: false,
        spikeMultiplier: spikeThreshold,
      };
    }

    const emaValues = EMA.calculate(volumes, emaPeriod);
    const currentVolume = volumes[volumes.length - 1];
    const emaVolume = emaValues[emaValues.length - 1];
    const volumeRatio = emaVolume === 0 ? 0 : currentVolume / emaVolume;

    return {
      currentVolume,
      emaVolume,
      volumeRatio,
      isSpike: volumeRatio >= spikeThreshold,
      spikeMultiplier: spikeThreshold,
    };
  }

  /**
   * Get volume trend direction.
   * Returns positive for increasing volume, negative for decreasing.
   */
  static trend(volumes: number[], period: number = 10): number {
    if (volumes.length < period) return 0;
    const recent = volumes.slice(-period);
    const firstHalf = recent.slice(0, Math.floor(period / 2));
    const secondHalf = recent.slice(Math.floor(period / 2));
    const avgFirst =
      firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const avgSecond =
      secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
    return avgFirst === 0 ? 0 : (avgSecond - avgFirst) / avgFirst;
  }
}
