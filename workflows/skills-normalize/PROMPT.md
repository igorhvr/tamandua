
Run the tamandua workflow skill-audit to analyze all active skills in the current project.

**Goal:** Identify redundant, overlapping, or highly similar skills that inflate context 
size and increase model hallucination risk.

**Steps:**
1. Use the tamanduá `skill-audit` workflow to scan and compare all registered skills
2. Flag skills that are duplicated, semantically overlapping, or could be consolidated
3. For each flagged group, explain why they're redundant and recommend whether to 
   remove or merge them

**Output:** Generate a final report  with:
- Summary of total skills analyzed vs. flagged
- Grouped findings (redundant pairs/clusters) with similarity justification
- Clear recommendation per group: remove, merge, or keep — with rationale
- Estimated context savings from the proposed cleanup
