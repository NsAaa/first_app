module.exports = {
  apps: [
    {
      name: 'solana-bot',
      script: 'dist/bot.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '10s',
      env: {
        NODE_ENV: 'production',
      },
      log_file: 'logs/pm2-combined.log',
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
