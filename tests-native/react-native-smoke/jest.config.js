module.exports = {
  preset: 'react-native',
  // pnpm's physical paths begin with node_modules/.pnpm, so the preset's
  // default allowlist does not recognize React Native packages.
  transformIgnorePatterns: ['node_modules/(?!.*(?:react-native|@react-native)/)'],
};
