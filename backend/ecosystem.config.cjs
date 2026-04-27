module.exports = {
  apps: [
    {
      name: 'shopee-backend',
      script: 'src/app.js',
      cwd: '/home/user/shopee-dashboard/backend',
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      error_file: '/home/user/shopee-dashboard/backend/logs/error.log',
      out_file: '/home/user/shopee-dashboard/backend/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
