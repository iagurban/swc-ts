import { catchingAsync, isTruthy, retrying } from '@grbn/kit';
import { type Options, transformFile } from '@swc/core';
import { spawn } from 'child_process';
import chokidar from 'chokidar';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { glob } from 'glob';
import micromatch from 'micromatch';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Define the SWC configuration for consistency.
 */
const defaultSwcOptopns: Options = {
  jsc: {
    parser: {
      syntax: 'typescript',
      tsx: false, // Set to true if you're using React/TSX
      decorators: true, // Enable if you use decorators
    },
    transform: {
      legacyDecorator: true,
      decoratorMetadata: true,
    },
    target: 'es2021', // Target modern JavaScript version
    keepClassNames: true,
  },
  module: {
    type: 'commonjs', // Or "es6" depending on your needs
    importInterop: 'swc',
  },
  sourceMaps: true, // Generate source maps for easier debugging
};

const resolve = (importPath: string, fileBeingCompiled: string) => {
  let error: unknown;
  for (const p of [importPath, `${importPath}.ts`, `${importPath}.tsx`, `${importPath}.js`]) {
    try {
      return require.resolve(p, {
        paths: [path.dirname(fileBeingCompiled)],
      });
    } catch (e) {
      error = e;
    }
  }
  throw error;
};

/**
 * Resolves an import path to its on-disk location and determines the
 * correct suffix (.js or /index.js) to add.
 * @param importPath The original import path (e.g., '@poslah/util/fastify-bootstrap')
 * @param fileBeingCompiled The absolute path to the .ts file containing the import.
 * @returns The original path with the correct suffix, or the original path if it's not a local module.
 */
function resolveAndFixImport(importPath: string, fileBeingCompiled: string): string {
  try {
    if (path.extname(importPath) === `.json`) {
      return importPath;
    }

    if (/^(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_-]+$/.test(importPath)) {
      return importPath;
    }

    // This is the core logic. We ask Node.js to find the *actual file*

    const resolvedPath = resolve(importPath, fileBeingCompiled);

    // native module

    if (!path.isAbsolute(resolvedPath)) {
      return importPath;
    }

    const relativeToCwd = path.relative(process.cwd(), resolvedPath);

    // external library

    if (/(?:^|..\/)+node_modules\//.test(relativeToCwd)) {
      return importPath;
    }

    const resolvedBasename = path.basename(resolvedPath);

    if (resolvedBasename === 'index.js' || resolvedBasename === 'index.ts') {
      return `${importPath}/index.js`;
    }

    if ([`.ts`, `.tsx`].includes(path.extname(importPath))) {
      return `${importPath.slice(0, -3)}.js`;
    }

    return `${importPath}.js`;
  } catch (error) {
    console.error(`Error while processing import ${importPath} from ${fileBeingCompiled}`);

    throw error;
  }
}

/**
 * Compiles a single file with SWC, reads the existing output,
 * and only writes the new file if the content has changed.
 * This preserves the file's modification time if the output is identical.
 */
async function compileFile(
  absoluteFilePath: string,
  srcDir: string,
  outDir: string,
  verbose: boolean,
  swcOptions: Record<string, unknown>
): Promise<void> {
  try {
    // Calculate the final output path
    const relativePath = path.relative(srcDir, absoluteFilePath);
    const outPath = path.join(outDir, relativePath).replace(/\.tsx?$/, '.js');
    const mapPath = `${outPath}.map`;

    const { code, map } = await transformFile(path.join(srcDir, relativePath), swcOptions);

    // 1. Compile the changed file in memory
    let fixedCode = [
      // should return the same groups
      /(import[\s\S]*?from\s+)(['"])(.*?)(['"]\s*;)/g,
      /(require\s*\(\s*)(['"])(.*?)(['"]\s*\))/g,
    ].reduce(
      (result, regex) =>
        result.replace(
          regex,
          (match, prefix, open, importPath, close) =>
            `${prefix}${open}${resolveAndFixImport(importPath, absoluteFilePath)}${close}`
        ),
      code
    );

    if (map) {
      fixedCode += `\n//# sourceMappingURL=${path.basename(mapPath)}`;
    }

    // 2. Read the existing file if it exists
    const existingCode = await catchingAsync(
      () => readFile(outPath, 'utf-8'),
      () => ``
    );

    // 3. Compare content and only write if it's different
    if (fixedCode.trim() !== existingCode.trim()) {
      if (verbose) {
        console.log(`[SWC] Change detected, writing to ${outPath}`);
      }
      // Ensure the directory exists before writing
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, fixedCode);
      if (map) {
        await writeFile(mapPath, map);
      }
    } else {
      if (verbose) {
        console.log(`[SWC] No output change for ${outPath}, skipping write.`);
      }
    }
  } catch (error) {
    console.error(`[SWC] Error processing ${absoluteFilePath}:`, error);
  }
}

// --- Mode Functions ---

/**
 * Runs a one-time build of all .ts files in the srcDir.
 */
async function runBuild(
  srcDir: string,
  outDir: string,
  verbose: boolean,
  excludePatterns: string[],
  swcOptions: Record<string, unknown>
): Promise<void> {
  console.log(`[SWC] Running build for ${srcDir}...`);
  const files = await glob(`${srcDir}/**/*.{ts,tsx}`, {
    ignore: excludePatterns,
  });
  await Promise.all(files.map(file => compileFile(file, srcDir, outDir, verbose, swcOptions)));
  console.log(`[SWC] Build complete. Processed ${files.length} files.`);
}

/**
 * Runs a one-time build and then watches for changes.
 */
async function runWatch(
  srcDir: string,
  outDir: string,
  verbose: boolean,
  excludePatterns: string[],
  swcOptions: Record<string, unknown>
): Promise<void> {
  // 1. Run a full build on startup
  await runBuild(srcDir, outDir, verbose, excludePatterns, swcOptions);

  // 2. Initialize the chokidar watcher
  const watcher = chokidar
    .watch(`.`, {
      ignored: (filePath, stats) => {
        if (micromatch.isMatch(filePath, excludePatterns)) {
          return true;
        }
        // If it's a file, ignore it if it's dot-file, or .d.ts-file, or any not a .ts-file
        if (stats?.isFile()) {
          return (
            path.basename(filePath).startsWith('.') ||
            filePath.endsWith('.d.ts') ||
            !(filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
          );
        }
        // Otherwise, don't ignore it (this keeps all directories for traversal)
        return false;
      },
      persistent: true,
      cwd: srcDir,
    })
    .on('add', filePath => compileFile(path.join(srcDir, filePath), srcDir, outDir, verbose, swcOptions))
    .on('change', filePath => compileFile(path.join(srcDir, filePath), srcDir, outDir, verbose, swcOptions))
    .on('ready', () => {
      // This will fire once the initial scan is complete
      if (verbose) {
        console.log('[SWC] Initial scan complete. Ready for changes.');
      }
    })
    .on('error', error => {
      // This will fire if the watcher encounters an error
      console.error('[SWC] Watcher error:', error);
    });

  if (verbose) {
    console.log(`[SWC] Watching for changes in ${srcDir}...`);
  }
}

/**
 * Starts the TSC --watch process for declaration files (.d.ts).
 */
function startTsc(
  tsConfigPath: string,
  outDir: string,
  watch: boolean,
  verbose: boolean,
  declarationsDir: string
) {
  return new Promise<number>((resolve, reject) => {
    console.log(`[TSC] Starting declaration file watcher for ${tsConfigPath}...`);

    const tscProcess = spawn(
      'yarn',
      [
        'tsc',
        '-p',
        tsConfigPath,
        '--declarationDir',
        path.join(outDir, declarationsDir),
        watch && '--watch',
        '--emitDeclarationOnly',
        watch && '--preserveWatchOutput',
      ].filter(isTruthy),
      {
        stdio: 'inherit',
        shell: true,
        cwd: path.dirname(tsConfigPath),
      }
    );

    tscProcess.on('exit', code => {
      if (code === 0) {
        if (verbose) {
          console.log('[TSC] .d.ts generation complete.');
        }
        resolve(code);
      } else {
        reject(new Error(`[TSC] Process exited with code ${code}`));
      }
    });

    tscProcess.on('error', err => {
      console.error('[TSC] Watcher failed to start:', err);
    });
  });
}

// --- Main Execution ---

/**
 * Main function to parse arguments and start the correct mode.
 */
async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('s', {
      alias: 'src',
      type: 'string',
      description: 'Source directory',
      demandOption: true,
    })
    .option('d', {
      alias: 'outDir',
      type: 'string',
      description: 'Output directory',
      demandOption: true,
    })
    .option('p', {
      alias: 'project',
      type: 'string',
      description: 'Path to the tsconfig.json file',
    })
    .option('c', {
      alias: 'config',
      type: 'string',
      description: 'Path to the .swcrc file',
    })
    .option('t', {
      alias: 'types-dir',
      type: 'string',
      description: `Path to the declarations output folder (relative to "out" directory)`,
      default: `./`,
    })
    .option('w', {
      alias: 'watch',
      type: 'boolean',
      description: 'Enable watch mode',
      default: false,
    })
    .option('v', {
      alias: 'verbose',
      type: 'boolean',
      description: 'Enable verbose mode',
      default: false,
    })
    .help().argv;

  // Resolve to absolute paths
  const srcDir = path.resolve(argv.s);
  const outDir = path.resolve(argv.d);
  const tsConfigPath = argv.p && path.resolve(argv.p);
  const swcOptions = argv.c ? JSON.parse((await readFile(argv.c)).toString()) : defaultSwcOptopns;

  let excludePatterns: string[] = [];
  if (tsConfigPath) {
    try {
      const tsconfigRaw = await readFile(tsConfigPath, 'utf-8');
      const tsconfig = JSON.parse(tsconfigRaw);
      if (tsconfig.exclude && Array.isArray(tsconfig.exclude)) {
        excludePatterns = tsconfig.exclude;
      }
    } catch (error) {
      console.warn(
        `[SWC] Warning: Could not read or parse tsconfig.json at ${tsConfigPath}. Ignoring exclude paths.`
      );
    }
  }

  if (argv.w) {
    // Watch mode
    if (tsConfigPath) {
      void retrying(
        () => 1000, // on some critical error that kills the process
        () => startTsc(tsConfigPath, outDir, true, argv.v, argv.t)
      );
    }

    await runWatch(srcDir, outDir, argv.v, excludePatterns, swcOptions);
  } else {
    // Build mode
    await Promise.all(
      [
        tsConfigPath && startTsc(tsConfigPath, outDir, false, argv.v, argv.t),
        runBuild(srcDir, outDir, argv.v, excludePatterns, swcOptions),
      ].filter(isTruthy)
    );
  }
}

// Run the script
main().catch(err => {
  console.error(err);
  process.exit(1);
});
