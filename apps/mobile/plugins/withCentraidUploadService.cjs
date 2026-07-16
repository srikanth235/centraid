const { AndroidConfig, withAndroidManifest } = require('@expo/config-plugins');

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.POST_NOTIFICATIONS',
];

module.exports = function withCentraidUploadService(config) {
  let nextConfig = config;
  for (const permission of PERMISSIONS)
    nextConfig = AndroidConfig.Permissions.withPermissions(nextConfig, [permission]);
  return withAndroidManifest(nextConfig, (result) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(result.modResults);
    application.service = application.service ?? [];
    const name = '.upload.UploadForegroundService';
    const existing = application.service.find((service) => service.$?.['android:name'] === name);
    if (!existing) {
      application.service.push({
        $: {
          'android:name': name,
          'android:exported': 'false',
          'android:foregroundServiceType': 'dataSync',
        },
      });
    }
    return result;
  });
};
