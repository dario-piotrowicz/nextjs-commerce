import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { existsSync, globSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ENTRYPOINT = import.meta.dirname + '/index.ts';

const REPO_ROOT = path.resolve(import.meta.dirname + '/..');

const BASE_DIR = path.resolve(REPO_ROOT + '/.next');
const APP_BASE_DIR = path.resolve(BASE_DIR + '/standalone');
const NEXT_DIR = path.resolve(APP_BASE_DIR + '/.next');
const NEXT_SERVER_DIR = path.resolve(NEXT_DIR + '/server');

const OUTFILE = APP_BASE_DIR + '/worker.mjs';

execSync(`mkdir -p ${BASE_DIR}/assets/_next`);
execSync(`cp -R ${BASE_DIR}/static ${BASE_DIR}/assets/_next/`);
if (existsSync(`${REPO_ROOT}/public`)) {
  execSync(`cp -R ${REPO_ROOT}/public/* ${BASE_DIR}/assets/`);
}

const nextConfigStr = readFileSync(APP_BASE_DIR + '/server.js', 'utf8').match(
  /const nextConfig = ({.+?})\n/
)[1];

let replaceRelativePlugin = {
  name: 'replaceRelative',
  setup(build) {
    // Can't use custom require hook
    build.onResolve({ filter: /^\.\/require-hook$/ }, (args) => ({
      path: path.join(import.meta.dirname, './shim-empty.mjs')
    }));
  }
};

await esbuild.build({
  entryPoints: [ENTRYPOINT],
  bundle: true,
  outfile: OUTFILE,
  alias: {
    'next/dist/experimental/testmode/server': path.join(import.meta.dirname, './shim-empty.mjs'),
    'next/dist/compiled/ws': path.join(import.meta.dirname, './shim-empty.mjs'),
    '@next/env': path.join(import.meta.dirname, './shim-env.mjs'),
    '@opentelemetry/api': path.join(import.meta.dirname, './shim-throw.mjs'),
    "next/dist/compiled/edge-runtime": path.join(import.meta.dirname, './shim-empty.mjs'),
  },
  plugins: [replaceRelativePlugin],
  format: 'esm',
  target: 'esnext',
  minify: false,
  define: {
    'process.env.NEXT_RUNTIME': '"nodejs"',
    __dirname: '""',
    'globalThis.__NEXT_HTTP_AGENT': '{}',
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_MINIMAL': 'true',
    'process.env.NEXT_PRIVATE_MINIMAL_MODE': 'true',
    __non_webpack_require__: 'require',
    'process.env.__NEXT_PRIVATE_STANDALONE_CONFIG': JSON.stringify(nextConfigStr)
  },
  platform: 'node',
  metafile: true,
  banner: {
    js: `
globalThis.setImmediate ??= (c) => setTimeout(c, 0);
globalThis.__dirname ??= "";
    `
  }
});

let contents = readFileSync(OUTFILE, 'utf-8');

contents = contents.replace(/__require\d?\(/g, 'require(').replace(/__require\d?\./g, 'require.');

contents = contents.replace(
  'getBuildId() {',
  `getBuildId() {
    return ${JSON.stringify(readFileSync(NEXT_DIR + '/BUILD_ID', 'utf-8').trim())};
  `
);

const manifestJsons = globSync(NEXT_DIR + '/**/*-manifest.json').map((file) =>
  file.replace(APP_BASE_DIR + '/', '')
);

contents = contents.replace(
  /function loadManifest\((.+?), .+?\) {/,
  `$&
  ${manifestJsons
    .map(
      (manifestJson) => `
        if ($1.endsWith("${manifestJson}")) {
          return ${readFileSync(APP_BASE_DIR + '/' + manifestJson, 'utf-8')};
        }
      `
    )
    .join('\n')}
  throw new Error("Unknown loadManifest: " + $1);
  `
);

const pagesManifestFile = NEXT_SERVER_DIR + '/pages-manifest.json';
const appPathsManifestFile = NEXT_SERVER_DIR + '/app-paths-manifest.json';

const pagesManifestFiles = existsSync(pagesManifestFile)
  ? Object.values(JSON.parse(readFileSync(pagesManifestFile, 'utf-8'))).map(
    (file) => '.next/server/' + file
  )
  : [];
const appPathsManifestFiles = existsSync(appPathsManifestFile)
  ? Object.values(JSON.parse(readFileSync(appPathsManifestFile, 'utf-8'))).map(
    (file) => '.next/server/' + file
  )
  : [];
const allManifestFiles = pagesManifestFiles.concat(appPathsManifestFiles);

const htmlPages = allManifestFiles.filter((file) => file.endsWith('.html'));
const pageModules = allManifestFiles.filter((file) => file.endsWith('.js'));

contents = contents.replace(
  /const pagePath = getPagePath\(.+?\);/,
  `$&
  ${htmlPages
    .map(
      (htmlPage) => `
        if (pagePath.endsWith("${htmlPage}")) {
          return ${JSON.stringify(readFileSync(APP_BASE_DIR + '/' + htmlPage, 'utf-8'))};
        }
      `
    )
    .join('\n')}
  ${pageModules
    .map(
      (module) => `
        if (pagePath.endsWith("${module}")) {
          return require("${APP_BASE_DIR}/${module}");
        }
      `
    )
    .join('\n')}
  throw new Error("Unknown pagePath: " + pagePath);
  `
);

contents = contents.replace(
  / ([a-zA-Z0-9_]+) = require\("url"\);/g,
  ` $1 = require("url");
    const nodeUrl = require("node-url");
    $1.parse = nodeUrl.parse.bind(nodeUrl);
    $1.format = nodeUrl.format.bind(nodeUrl);
    $1.pathToFileURL = (path) => {
      console.log("url.pathToFileURL", path);
      return new URL("file://" + path);
    }
  `
);

const HAS_APP_DIR = existsSync(NEXT_SERVER_DIR + '/app');
const HAS_PAGES_DIR = existsSync(NEXT_SERVER_DIR + '/pages');

contents = contents.replace(
  'function findDir(dir, name) {',
  `function findDir(dir, name) {
    if (dir.endsWith(".next/server")) {
      if (name === "app") return ${HAS_APP_DIR};
      if (name === "pages") return ${HAS_PAGES_DIR};
    }
    throw new Error("Unknown findDir call: " + dir + " " + name);
`
);

contents = contents.replace(
  'async function loadClientReferenceManifest(manifestPath, entryName) {',
  `async function loadClientReferenceManifest(manifestPath, entryName) {
    const context = await evalManifestWithRetries(manifestPath);
    return context.__RSC_MANIFEST[entryName];
`
);

const manifestJss = globSync(NEXT_DIR + '/**/*_client-reference-manifest.js').map((file) =>
  file.replace(APP_BASE_DIR + '/', '')
);

contents = contents.replace(
  /function evalManifest\((.+?), .+?\) {/,
  `$&
  ${manifestJss
    .map(
      (manifestJs) => `
        if ($1.endsWith("${manifestJs}")) {
          require("${APP_BASE_DIR}/${manifestJs}");
          return {
            __RSC_MANIFEST: {
              "${manifestJs
          .replace('.next/server/app', '')
          .replace(
            '_client-reference-manifest.js',
            ''
          )}": globalThis.__RSC_MANIFEST["${manifestJs
            .replace('.next/server/app', '')
            .replace('_client-reference-manifest.js', '')}"],
            },
          };
        }
      `
    )
    .join('\n')}
  throw new Error("Unknown evalManifest: " + $1);
  `
);

contents = contents.replace(
  /var NodeModuleLoader = class {.+?async load\((.+?)\) {/s,
  `$&
  ${pageModules
    .map(
      (module) => `
        if ($1.endsWith("${module}")) {
          return require("${APP_BASE_DIR}/${module}");
        }
      `
    )
    .join('\n')}
  throw new Error("Unknown NodeModuleLoader: " + $1);
  `
);

writeFileSync(OUTFILE, contents);

const chunks = readdirSync(NEXT_SERVER_DIR + '/chunks')
  .filter((chunk) => /^\d+\.js$/.test(chunk))
  .map((chunk) => chunk.replace(/\.js$/, ''));
const webpackRuntimeFile = NEXT_SERVER_DIR + '/webpack-runtime.js';
writeFileSync(
  webpackRuntimeFile,
  readFileSync(webpackRuntimeFile, 'utf-8').replace(
    '__webpack_require__.f.require = (chunkId, promises) => {',
    `__webpack_require__.f.require = (chunkId, promises) => {
      if (installedChunks[chunkId]) return;
      ${chunks
      .map(
        (chunk) => `
        if (chunkId === ${chunk}) {
          installChunk(require("./chunks/${chunk}.js"));
          return;
        }
      `
      )
      .join('\n')}
    `
  )
);

const kvAssetHandlerBase = existsSync(
  REPO_ROOT + '/node_modules/.pnpm/node_modules/@cloudflare/kv-asset-handler'
)
  ? REPO_ROOT + '/node_modules/.pnpm/node_modules/@cloudflare/kv-asset-handler'
  : REPO_ROOT + '/node_modules/@cloudflare/kv-asset-handler';

const cloudflareAssetsFile = kvAssetHandlerBase + '/dist/index.js';
writeFileSync(
  cloudflareAssetsFile,
  readFileSync(cloudflareAssetsFile, 'utf-8').replace(
    'const mime = __importStar(require("mime"));',
    'let mime = __importStar(require("mime")); mime = mime.default ?? mime;'
  )
);

const unenvBase = existsSync(REPO_ROOT + '/node_modules/.pnpm/node_modules/unenv')
  ? REPO_ROOT + '/node_modules/.pnpm/node_modules/unenv'
  : REPO_ROOT + '/node_modules/unenv';

const unenvProcessFiles = [
  unenvBase + '/runtime/node/process/$cloudflare.cjs',
  unenvBase + '/runtime/node/process/$cloudflare.mjs'
];
for (const unenvFile of unenvProcessFiles) {
  writeFileSync(
    unenvFile,
    readFileSync(unenvFile, 'utf-8').replace(
      'const unpatchedGlobalThisProcess = globalThis["process"];',
      'const processKey = "process"; const unpatchedGlobalThisProcess = globalThis[processKey];'
    )
  );
}
