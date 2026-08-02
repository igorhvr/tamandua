import { OracleRuntimeError } from './paths.mjs';

export class FindingCollector {
  #findings = [];

  add(id, summary, details = {}) {
    if (typeof id !== 'string' || id.length === 0 || typeof summary !== 'string' || summary.length === 0) {
      throw new OracleRuntimeError('finding id and summary must be nonempty strings');
    }
    this.#findings.push({ id, summary, ...details });
    return this;
  }

  get length() {
    return this.#findings.length;
  }

  toJSON() {
    return this.#findings
      .map((finding) => structuredClone(finding))
      .sort((left, right) => left.id.localeCompare(right.id) || left.summary.localeCompare(right.summary));
  }
}
