import path from 'path';
import { fileURLToPath } from 'url';
import TerserPlugin from 'terser-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const multiEntry = {
  "guidex-text-prompt-lambda": './lambdas/guidex-text-prompt-lambda.mjs',
  "guidex-image-annotation-lambda": './lambdas/guidex-image-annotation-lambda.mjs',
  "guidex-image-recognition-lambda": './lambdas/guidex-image-recognition-lambda.mjs',
  "guidex-text-to-speech-lambda": './lambdas/guidex-text-to-speech-lambda.mjs',
};

export default (env = {}) => {
  const entry = env.entry || multiEntry;
  const outputFilename =
    env.outputFilename || (typeof entry === 'string' ? 'index.js' : '[name].js');
  const isProduction = env.production !== false;

  return {
    entry,
    output: {
      filename: outputFilename,
      path: path.resolve(__dirname, 'dist'),
      libraryTarget: 'commonjs2',
      clean: true,
    },
    target: 'node',
    mode: isProduction ? 'production' : 'development',
    optimization: {
      usedExports: true,
      splitChunks: false,
      runtimeChunk: false,
      concatenateModules: isProduction,
      minimize: isProduction,
      minimizer: isProduction
        ? [
            new TerserPlugin({
              terserOptions: {
                compress: {
                  defaults: true,
                  passes: 2,
                },
                format: {
                  beautify: true,
                  comments: false,
                },
              },
              extractComments: false,
            }),
          ]
        : [],
    },
    devtool: false,
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env'],
            },
          },
        },
      ],
    },
  };
};
