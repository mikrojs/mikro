// Branch the rolling release PR is created from. Used as the gate for
// triggering the `release` mode in release.yml on PR merge.
export const RELEASE_BRANCH = 'ci/release-main'

// Label that opts a PR into a one-shot preview publish. The label is
// removed by the release workflow after a successful publish, so each
// preview must be explicitly opted in via re-adding the label.
export const PREVIEW_LABEL = 'release:preview'
