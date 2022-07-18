// @ts-check
const { Transformer } = require('@parcel/plugin');
// @ts-ignore
const { relativeUrl } = require('@parcel/utils');
const { default: SourceMap } = require('@parcel/source-map');
const { default: ThrowableDiagnostic, errorToDiagnostic } = require('@parcel/diagnostic');
const svelte = require('svelte/compiler');

const AST_VERSION = '0.1.0';

module.exports.default = new Transformer({
  canReuseAST({ ast }) {
    return ast.type === 'transformer-svelte' && ast.version === AST_VERSION;
  },
  async parse({ asset, options, logger }) {
    try {
      const minify = asset.env.shouldOptimize ?? true;
      const filename = relativeUrl(options.projectRoot, asset.filePath);
      logger.verbose({ message: 'compiling file: ' + filename });

      let code = await asset.getCode();

      /** @type {{sourcemap?:string|object, dependencies?:string[]}} */
      let preprocessor = {};

      if (require.resolve('svelte-preprocess')) {
        /** @type {import("svelte-preprocess")["default"]} */
        // @ts-ignore
        const sveltePreprocess = require('svelte-preprocess');
        ({
          code,
          map: preprocessor.sourcemap,
          dependencies: preprocessor.dependencies,
        } = await svelte.preprocess(code, sveltePreprocess(), { filename: asset.filePath }));
        if (preprocessor.sourcemap) sanitizeMap(preprocessor.sourcemap, filename);
      }
      /**@type {ReturnType<typeof svelte.compile>}*/
      let result;
      result = svelte.compile(code, {
        filename: asset.filePath,
        format: 'esm',
        generate: 'dom',
        dev: minify,
        legacy: false,
        customElement: false,
        css: true,
        preserveComments: !minify,
        preserveWhitespace: !minify,
        enableSourcemap: {
          js: true,
          css: false,
        },
        sourcemap: preprocessor.sourcemap,
      });
      if (!minify && require.resolve('svelte-hmr')) {
        const { createMakeHot } = require('svelte-hmr');
        const makeHot = createMakeHot({
          meta: 'module.hot',
          walk: svelte.walk,
          hotApi: 'npm:svelte-hmr/runtime/hot-api-esm.js',
          adapter: 'npm:svelte-hmr/runtime/proxy-adapter-dom.js',
          absoluteImports: false,
          hotOptions: {},
          versionNonAbsoluteImports: false,
        });
        result.js.code = makeHot({
          id: filename,
          compiledCode: result.js.code,
          hotOptions: {
            injectCss: true,
          },
          compiled: result,
          originalCode: code,
          compileOptions: {},
        });
      }

      logger.warn(
        result.warnings.map(war => {
          const codeFrames = [];
          if (war.filename && war.start && war.end) {
            codeFrames.push({
              filePath: war.filename,
              code: war.code,
              codeHighlights: [
                {
                  start: {
                    line: war.start.line,
                    column: war.start.column,
                  },
                  end: {
                    line: war.end.line,
                    column: war.end.column,
                  },
                },
              ],
            });
          }
          return {
            message: war.message,
            codeFrames,
          };
        })
      );
      return {
        type: 'transformer-svelte',
        version: AST_VERSION,
        program: { result, dependencies: preprocessor.dependencies, filename },
      };

      //
    } catch (err) {
      err.filePath = asset.filePath;
      let diagnostic = errorToDiagnostic(err, {
        origin: 'parcel-transformer-svelte',
      });

      throw new ThrowableDiagnostic({
        diagnostic,
      });
    }
  },
  async transform({ asset, options, logger }) {
    /** @type {(import("@parcel/types").TransformerResult|import("@parcel/types").MutableAsset)[]} */
    const assets = [asset];
    try {
      const ast = await asset.getAST();
      if (!ast) throw new Error('AST not foud');
      const type = asset.query.get('type') || 'main';
      const { filename, dependencies, result } = ast.program;
      logger.verbose({ message: 'importing ' + type + ' : ' + filename });

      if (type === 'main') {
        //
        asset.type = 'js';
        asset.setMap(null);
        let code = '';
        if (result.css?.code?.trim())
          //
          code += 'import "/' + JSON.stringify(filename).slice(1, -1) + '?type=css";';
        if (result.js?.code?.trim())
          code +=
            'import Component from "/' +
            JSON.stringify(filename).slice(1, -1) +
            '?type=js";export default Component;//if(module.hot){module.hot.dispose(()=>{});module.hot.accept(()=>{})}';
        asset.setCode(code);
        dependencies?.forEach((/** @type {any} */ dep) => {
          const specifier = '/' + relativeUrl(options.projectRoot, dep);
          asset.addDependency({
            specifier,
            specifierType: 'esm',
            bundleBehavior: 'isolated',
            resolveFrom: specifier,
          });
        });
        //
      } else if (type === 'css') {
        //
        asset.type = 'css';
        asset.setCode(result.css.code);
        if (result.css.map) asset.setMap(getSourcemap(result.css.map, options.projectRoot, filename));
        //
      } else if (type === 'js') {
        asset.type = 'js';
        asset.setCode(result.js.code);
        if (result.js.map) asset.setMap(getSourcemap(result.js.map, options.projectRoot, filename));
      }

      //
    } catch (err) {
      err.filePath = asset.filePath;
      let diagnostic = errorToDiagnostic(err, {
        origin: 'parcel-transformer-svelte',
      });

      throw new ThrowableDiagnostic({
        diagnostic,
      });
    }
    return assets;
  },
});

/**
 * @param {{ sources: readonly string[]; sourcesContent?: readonly (string | null)[] | undefined; names: readonly string[]; mappings: string; version?: number | undefined; file?: string | undefined; sourceRoot?: string | undefined; }} map
 * @param {string} projectRoot
 * @param {string} filename
 */
function getSourcemap(map, projectRoot, filename) {
  sanitizeMap(map, filename);
  const newMap = new SourceMap(projectRoot);
  newMap.addVLQMap(map);
  return newMap;
}

/**
 * @param {{ sources: readonly string[]; sourcesContent?: readonly (string | null)[] | undefined; names: readonly string[]; mappings: string; version?: number | undefined; file?: string | undefined; sourceRoot?: string | undefined; }} map
 * @param {string} filename
 */
function sanitizeMap(map, filename) {
  map.file = filename;
  map.sources = [filename];
}
