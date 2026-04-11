module.exports = {
  apps: [
    {
      name: 'remote-server',
      cwd: __dirname,
      script: 'dist/index.cjs',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      min_uptime: '10s',
      max_restarts: 10,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        HOST: '0.0.0.0',
        NODE_USE_ENV_PROXY: '1',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '0.0.0.0',
        NODE_USE_ENV_PROXY: '1',
        ACP_RETRY_MAX: '3',
        ACP_RETRY_BASE_DELAY_MS: '1000',
      },
    },
  ],
};
