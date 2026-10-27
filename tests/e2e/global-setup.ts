import { execSync } from 'node:child_process';

/** e2e 直接运行 out/ 下的正式构建产物，先确保构建是新的。 */
export default function globalSetup(): void {
  execSync('bun run build', {stdio: 'inherit'});
}
