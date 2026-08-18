module.exports = {
  apps: [
    {
      name: 'mission-control-server',
      script: 'server/index.js',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
        // Set these in the shell or a process manager secret store — never commit values:
        //   MC_AUTH_USER, MC_AUTH_PASS  — dashboard basic auth
        //   MC_AGENT_TOKEN              — bearer token for agent API access (dsh plugin)
      }
    }
  ]
};
