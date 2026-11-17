import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'scripts/**/*.test.js'],
    // A stand-in owner, so modules that read the owner at import time have
    // one. Tests never reach the network or a real account.
    env: {
      MOD_OWNER_DID: 'did:plc:owner0000000000000000000',
      DATABASE_PATH: ':memory:',
      // A provider with a key, so the paths that need a model are on.
      // Nothing here calls a real model.
      MODEL_PROVIDER: 'gateway',
      AI_GATEWAY_API_KEY: 'test-key-not-real',
      // A second model, so the escalation paths are exercised.
      MOD_ESCALATION_MODEL: 'test/escalation',
      // Slingshot reads with the global fetch, which the module mocks do not
      // cover. Its own tests pass the base URL they want.
      SLINGSHOT_URL: 'off',
      // No stream: index.js is never started by a test, but nothing should
      // think one is running.
      MOD_STREAM: 'false',
    },
  },
});
