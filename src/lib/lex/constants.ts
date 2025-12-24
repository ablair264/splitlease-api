/**
 * Lex Autolease constants - safe for client and server use
 */

/**
 * Session capture script to run in browser console
 * This extracts the session data needed for server-side API calls
 */
export const SESSION_CAPTURE_SCRIPT = `// Run this in the browser console while logged into associate.lexautolease.co.uk
(function captureSession() {
  const sessionData = {
    csrfToken: window.csrf_token,
    profile: {
      SalesCode: window.profile?.SalesCode || '',
      Discount: window.profile?.Discount || '-1',
      RVCode: window.profile?.RVCode || '00',
      Role: window.profile?.Role || '',
      Username: window.profile?.Username || ''
    },
    cookies: document.cookie,
    capturedAt: new Date().toISOString()
  };

  // Copy to clipboard
  const json = JSON.stringify(sessionData, null, 2);
  navigator.clipboard.writeText(json).then(() => {
    console.log('✅ Session data copied to clipboard!');
    console.log('Paste this into the admin panel to enable server-side quotes.');
  }).catch(() => {
    console.log('Session data (copy manually):');
    console.log(json);
  });

  return sessionData;
})();`;

/**
 * Vehicle extraction script that uses Lex API directly
 * Much faster and more reliable than DOM manipulation
 */
export const VEHICLE_EXTRACTION_SCRIPT = `// Run this in the browser console while logged into associate.lexautolease.co.uk
(async function extractVehicles() {
  const BASE_URL = '/services/Quote.svc';

  // Helper to call Lex API
  async function callApi(endpoint, data = {}) {
    const response = await fetch(BASE_URL + '/' + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-csrf-check': window.csrf_token
      },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error('API call failed: ' + endpoint);
    return response.json();
  }

  console.log('🚗 Starting Lex vehicle extraction...');
  console.log('Using CSRF token:', window.csrf_token ? '✓ Found' : '✗ Missing');

  const results = {
    makes: [],
    timestamp: new Date().toISOString(),
    extractedBy: window.profile?.Username || 'unknown'
  };

  try {
    // Step 1: Get all manufacturers
    console.log('📋 Fetching manufacturers...');
    const manufacturers = await callApi('GetManufacturers', {});
    console.log('Found ' + manufacturers.length + ' manufacturers');

    // Step 2: For each manufacturer, get models
    for (let i = 0; i < manufacturers.length; i++) {
      const mfr = manufacturers[i];
      const makeData = {
        code: mfr.Key || mfr.Id || mfr.ManufacturerId,
        name: mfr.Value || mfr.Name || mfr.ManufacturerName,
        models: []
      };

      console.log('Processing ' + (i + 1) + '/' + manufacturers.length + ': ' + makeData.name);

      try {
        const models = await callApi('GetModels', { manufacturerId: makeData.code });

        // Step 3: For each model, get variants
        for (let j = 0; j < models.length; j++) {
          const mdl = models[j];
          const modelData = {
            code: mdl.Key || mdl.Id || mdl.ModelId,
            name: mdl.Value || mdl.Name || mdl.ModelName,
            variants: []
          };

          try {
            const variants = await callApi('GetVariants', {
              manufacturerId: makeData.code,
              modelId: modelData.code
            });

            variants.forEach(v => {
              modelData.variants.push({
                code: v.Key || v.Id || v.VariantId,
                name: v.Value || v.Name || v.VariantName,
                capCode: v.CapCode || v.CAPCode || null
              });
            });
          } catch (e) {
            console.warn('  Could not get variants for ' + modelData.name + ': ' + e.message);
          }

          if (modelData.variants.length > 0) {
            makeData.models.push(modelData);
          }

          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (e) {
        console.warn('Could not get models for ' + makeData.name + ': ' + e.message);
      }

      if (makeData.models.length > 0) {
        results.makes.push(makeData);
      }

      // Progress save every 10 makes
      if ((i + 1) % 10 === 0) {
        console.log('Progress: ' + results.makes.length + ' makes with ' +
          results.makes.reduce((sum, m) => sum + m.models.length, 0) + ' models');
      }
    }

    // Summary
    const totalModels = results.makes.reduce((sum, m) => sum + m.models.length, 0);
    const totalVariants = results.makes.reduce((sum, m) =>
      sum + m.models.reduce((s, mdl) => s + mdl.variants.length, 0), 0);

    console.log('');
    console.log('✅ Extraction complete!');
    console.log('   Makes: ' + results.makes.length);
    console.log('   Models: ' + totalModels);
    console.log('   Variants: ' + totalVariants);

    // Download as JSON
    const dataStr = JSON.stringify(results, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lex-vehicles-' + Date.now() + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    console.log('📥 JSON file downloaded!');
    return results;

  } catch (error) {
    console.error('❌ Extraction failed:', error);
    console.log('');
    console.log('Troubleshooting:');
    console.log('1. Make sure you are logged into the Lex portal');
    console.log('2. Navigate to a quote page first');
    console.log('3. Check if window.csrf_token exists:', !!window.csrf_token);
    throw error;
  }
})();`;
