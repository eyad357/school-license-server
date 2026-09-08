'use strict';

require('dotenv').config();

const { createLicense } = require('../src/services/adminLicenseService');

async function main() {
  try {
    const license = await createLicense({
      productId: 'school-accreditation',
      maxDevices: 1,
      expiresAt: null,
    });

    console.log('\nLicense created successfully:\n');
    console.log(`Key:          ${license.license_key}`);
    console.log(`Product:      ${license.product_id}`);
    console.log(`Status:       ${license.status}`);
    console.log(`Max devices:  ${license.max_devices}`);
    console.log(`Expires:      ${license.expires_at || 'Never'}`);
    console.log(`ID:           ${license.id}`);
    console.log('');
  } catch (error) {
    console.error('Failed to create license:', error.message);
    process.exitCode = 1;
  }
}

main();