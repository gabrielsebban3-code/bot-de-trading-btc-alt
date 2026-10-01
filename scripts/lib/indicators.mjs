// Indicateurs techniques (fonctions pures). Serviront à l'onglet Setups.
export const Ind = {
  ema(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev;
    values.forEach((v, i) => {
      prev = i === 0 ? v : v * k + prev * (1 - k);
      out.push(prev);
    });
    return out;
  },

  // RSI de Wilder
  rsi(closes, period = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gain = (gain * (period - 1) + Math.max(d, 0)) / period;
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  },

  sma(values, period) {
    return values.map((_, i) => i < period - 1 ? null
      : values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  },

  // Indices des pivots bas/hauts (extremum local sur ±w bougies)
  pivots(values, w, type) {
    const idx = [];
    for (let i = w; i < values.length - w; i++) {
      const win = values.slice(i - w, i + w + 1);
      const ext = type === 'low' ? Math.min(...win) : Math.max(...win);
      if (values[i] === ext) idx.push(i);
    }
    return idx;
  },
};

