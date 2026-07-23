/** Stable and mutable repository metadata captured from GitHub. */
export interface RepositoryInventoryEntry {
  githubRepositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  defaultBranchHeadSha: string;
  isArchived: boolean;
}
