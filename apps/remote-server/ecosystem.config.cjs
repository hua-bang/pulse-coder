module.exports = {
  apps: [
    {
      name: 'remote-server',
      cwd: __dirname,
      script: 'dist/index.js',
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
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
