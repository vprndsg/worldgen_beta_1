// illusion.js – Tracks hidden influence values and provides simple persistence.
export const illusion = {
  state: { pos: 0, neg: 0 },
  init() {
    try {
      const saved = JSON.parse(localStorage.getItem('illusion_stat') || '{}');
      if (saved && typeof saved.pos === 'number' && typeof saved.neg === 'number') {
        this.state = saved;
      }
    } catch {}
  },
  record(tag, weight = 1) {
    if (tag === 'demiurge_affinity') this.state.pos += weight;
    if (tag === 'resistance') this.state.neg += weight;
    localStorage.setItem('illusion_stat', JSON.stringify(this.state));
  },
  value() {
    const t = this.state.pos + this.state.neg + 10;
    return Math.max(0, Math.min(1, this.state.pos / t));
  },
  tier() {
    const v = this.value();
    return v >= 1 ? 1 : v >= 0.75 ? 0.75 : v >= 0.5 ? 0.5 : v >= 0.25 ? 0.25 : 0;
  }
};
illusion.init();