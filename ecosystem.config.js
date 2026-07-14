module.exports = {
  apps: [
    {
      name: "browsefreely",
      script: "src/index.tsx",
      interpreter: "bun",
      env: {
        NODE_ENV: "production",
        PORT: 3065,
        RATE_LIMIT: 100,
        SESSION_SECRET: "change-me-to-a-long-random-string",
      },
    },
  ],
};
