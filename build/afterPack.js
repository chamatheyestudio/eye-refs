// Sign the Mac app. macOS remembers permissions (like the Documents folder) per
// signing certificate, so every version is signed with the same Eye Refs
// certificate and the permission carries over between updates.
// Without that certificate (local builds), fall back to ad hoc signing.
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = process.env.EYEREFS_SIGN_IDENTITY;
  const keychain = process.env.EYEREFS_SIGN_KEYCHAIN;
  const args = ['--force', '--deep', '--sign', identity || '-'];
  if (identity && keychain) args.push('--keychain', keychain);
  execFileSync('codesign', [...args, app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  execFileSync('codesign', ['-d', '-r-', app], { stdio: 'inherit' });
};
