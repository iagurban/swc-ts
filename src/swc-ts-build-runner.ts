import { catchingAsync } from '@grbn/kit';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

function pickExisting(paths: string[]): string | undefined {
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return undefined;
}

async function findBinPath(name: string): Promise<string> {
  return execSync(`yarn bin ${name}`).toString().trim();
}

const kill = (pid: number, signal: NodeJS.Signals) => {
  try {
    // Send SIGTERM to the entire process group to ensure all descendants are killed
    process.kill(-pid, signal);
  } catch (e) {
    console.error(`Error sending ${signal} to child process group: ${e}`);
  }
};

async function main() {
  const scriptToRun = pickExisting([
    path.join(path.dirname(process.argv[1]), './swc-ts-build.ts'),
    path.join(path.dirname(process.argv[1]), './swc-ts-build.js'),
  ]);
  if (!scriptToRun) {
    console.error('Failed to find script to run');
    process.exit(1);
  }
  const argsForScript = process.argv.slice(2);

  const command = await catchingAsync(
    () => findBinPath(`tsx`),
    () => findBinPath(`ts-node`)
  );

  const child = spawn(`yarn`, [`node`, command, scriptToRun, ...argsForScript], {
    detached: true, // Detach the child process into its own process group
    stdio: 'inherit', // Pipe child's stdio to parent's stdio
  });

  const handleShutdown = () => {
    console.log('Received shutdown signal. Attempting to gracefully shut down child process...');
    if (child.pid) {
      kill(child.pid, 'SIGTERM');
    }
    // Give the child process a grace period to shut down
    const timeout = setTimeout(() => {
      console.warn('Child process did not exit gracefully. Forcibly terminating...');
      if (child.pid) {
        kill(child.pid, 'SIGKILL');
      }
      process.exit(1); // Exit with an error code
    }, 5000); // 5-second grace period

    child.on('exit', () => {
      clearTimeout(timeout); // Clear timeout if the child exits
      process.exit(0); // Exit successfully
    });
  };

  // Register signal handlers
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  // If the child process exits on its own, the parent should also exit.
  child.on('exit', (code, _signal) => {
    process.exit(code || 0);
  });

  // The parent process needs to stay alive to catch signals and manage the child's lifecycle.
  // Therefore, we do not call child.unref().
}

// Call the main function and handle any unhandled rejections
main().catch(error => {
  console.error('An unhandled error occurred:', error);
  process.exit(1);
});
