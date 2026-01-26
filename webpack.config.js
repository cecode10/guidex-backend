import path from 'path';
import { fileURLToPath } from 'url';

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

  return {
    entry,
    output: {
      filename: outputFilename,
      path: path.resolve(__dirname, 'dist'),
      libraryTarget: 'commonjs2',
    },
    target: 'node',
    mode: 'development',
    optimization: {
      usedExports: true,
      splitChunks: false,
      runtimeChunk: false,
    },
    devtool: 'cheap-module-source-map',
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
