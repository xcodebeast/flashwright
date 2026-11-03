const workers = Number(process.env.WORKERS);

module.exports = {
  spec: 'tests/**/*.spec.mjs',
  reporter: 'dot',
  timeout: 30000,
  ...(workers > 1 ? { parallel: true, jobs: workers } : {}),
};
