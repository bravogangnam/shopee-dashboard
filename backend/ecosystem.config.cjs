const path = require('path');

const backendDir = __dirname;

module.exports = {
  apps: [
    {
      name: 'shopee-backend',
      script: 'src/app.js',
      cwd: backendDir,
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      error_file: path.join(backendDir, 'logs/error.log'),
      out_file: path.join(backendDir, 'logs/out.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
