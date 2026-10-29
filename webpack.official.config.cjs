/**
 * Webpack config for the OPTIONAL official (licensed) collaboration page.
 *
 * Only `public/official-src/main.js` is bundled. The output is
 * `public/official/bundle.js`, which is gitignored (`public/official/bundle.js*`);
 * `public/official/index.html` is committed and shows the build instructions when the
 * bundle is absent — the page never goes blank.
 *
 * Why a bundle is required here (and not for the lab console / mirror client):
 * the official packages are CommonJS, pull in SpreadJS itself, and import CSS, so they
 * cannot be loaded as classic <script> tags.
 *
 * Usage:  npm run build:official       (webpack --config webpack.official.config.cjs)
 *
 * This file is CommonJS (`.cjs`) because package.json sets `"type": "module"`.
 */
'use strict';

const path = require('node:path');

/** Bundle into public/official, even when invoked from another working directory. */
module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  target: 'web',
  entry: {
    bundle: path.resolve(__dirname, 'public/official-src/main.js'),
  },
  output: {
    path: path.resolve(__dirname, 'public/official'),
    filename: '[name].js',
    clean: false,
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.css$/i,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: { extensions: ['.js'] },
  // SpreadJS ships prebuilt UMD/CJS; no Node polyfills are needed in the browser.
  performance: { hints: false },
  stats: { errorDetails: true },
};
