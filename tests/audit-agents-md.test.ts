import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const auditPath = resolve(repoRoot, 'audit-agents-md.md');

function readAudit(): string {
  return readFileSync(auditPath, 'utf-8');
}

describe('US-001: AGENTS.md audit document', () => {
  it('audit document exists', () => {
    assert.doesNotThrow(() => readFileSync(auditPath, 'utf-8'));
  });

  it('lists outdated workflow directory references', () => {
    const content = readAudit();
    assert.ok(
      content.includes('feature-dev-merge'),
      'audit should mention outdated workflow reference'
    );
    assert.ok(
      content.includes('feature-dev-merge-worktree'),
      'audit should mention the worktree variant as canonical'
    );
  });

  it('lists historical / temporal language', () => {
    const content = readAudit();
    assert.ok(
      content.includes('now starts'),
      'audit should flag "now starts" as temporal language'
    );
  });

  it('lists all missing artifact types', () => {
    const content = readAudit();
    const artifacts = ['docs/creating-workflows.md', 'mcp-server.ts', 'cli.ts', 'README'];
    for (const artifact of artifacts) {
      assert.ok(
        content.includes(artifact),
        `audit should mention missing artifact: ${artifact}`
      );
    }
  });

  it('identifies verbose sections with condensation suggestions', () => {
    const content = readAudit();
    assert.ok(
      content.includes('Parallel Test Safety') || content.includes('parallel test'),
      'audit should identify Parallel Test Safety as verbose'
    );
    assert.ok(
      content.includes('Testing section'),
      'audit should identify Testing section as verbose'
    );
    assert.ok(
      content.includes('conden') || content.includes('Condense'),
      'audit should provide condensation suggestions'
    );
  });

  it('notes the Skills section scope issue', () => {
    const content = readAudit();
    assert.ok(
      content.includes('Skills and Agent Instructions') &&
        (content.includes('Artifacts to Review') || content.includes('Change Impact Review')),
      'audit should flag that Skills section narrow scope should be broadened'
    );
  });
});
