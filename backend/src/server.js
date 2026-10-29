'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const app = require('../index');
const PORT = Number(process.env.PORT || 8787);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 BNSmart Server running on http://localhost:${PORT}`);
    console.log(`   ├─ User Portal : http://localhost:${PORT}/`);
    console.log(`   ├─ Admin Logs  : http://localhost:${PORT}/admin`);
    console.log(`   ├─ Super Portal: http://localhost:${PORT}/super`);
    console.log(`   └─ Health Check: http://localhost:${PORT}/health\n`);
  });
}

module.exports = app;
