/**
 * Spawnable fixture (not itself a test): runs `resolveBaseRef` against the
 * repo path given on argv and exits 0 regardless of the result. Used by
 * test/git.test.ts to check the REAL child process's own stderr stream —
 * something only observable from outside the process, since `runGit`'s
 * stdio configuration is what determines whether a failing git subprocess's
 * stderr gets inherited by (and therefore visible on) this process's own
 * stderr, vs captured only on the thrown/caught error object.
 */
import { resolveBaseRef } from "../../src/git";

const repoPath = process.argv[2];
const ref = resolveBaseRef(repoPath);
process.stdout.write(ref + "\n");
