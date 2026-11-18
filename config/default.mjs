// Override these values locally by creating a config/local-test.mjs file (gitignored)
export default {
  /** Base URL of data-fair in the tests: requests to it are answered by nock, no instance is needed. */
  dataFairUrl: 'http://test.data-fair.local',
  /** API key sent to data-fair, irrelevant when using nock. */
  dataFairAPIKey: 'test-api-key'
}
