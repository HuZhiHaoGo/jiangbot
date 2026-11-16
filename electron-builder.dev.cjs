const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  appId: 'io.dsh.desktop.dev',
  productName: '匠宝 Dev',
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'dsh-desktop-dev',
    productName: '匠宝 Dev',
    dshDesktopChannel: 'development'
  },
  artifactName: 'dsh-desktop-dev-${os}-${arch}.${ext}',
  linux: {
    ...packageJson.build.linux,
    executableName: 'dsh-desktop-dev',
    artifactName: 'dsh-desktop-dev-linux-${arch}-${version}.${ext}'
  },
  win: {
    ...packageJson.build.win,
    executableName: 'JiangBotDev'
  },
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'JiangBot-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}
