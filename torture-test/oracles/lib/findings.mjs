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

  // Informational, NON-FAILING findings (adopted S19 policy, 2026-08-24): a
  // finding recorded through addInfo is stamped non_failing: true and therefore
  // may ride a PASS result — the output contract accepts PASS findings only when
  // EVERY finding is non_failing (see output.mjs validateOracleResponse). The
  // stamp is authoritative: it cannot be overridden by details.
  addInfo(id, summary, details = {}) {
    if (typeof id !== 'string' || id.length === 0 || typeof summary !== 'string' || summary.length === 0) {
      throw new OracleRuntimeError('finding id and summary must be nonempty strings');
    }
    this.#findings.push({ id, summary, ...details, non_failing: true });
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
