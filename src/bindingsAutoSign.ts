/** @file Automatic code signing for macOS binaries */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Check if a binary needs signing (macOS only)
 * @param binaryPath Absolute path to the binary
 * @returns true if signing is needed
 */
function needsSigning(binaryPath: string): boolean {
    let is_needs = false;
    if (process.platform === 'darwin') {
        if (fs.existsSync(binaryPath)) {
            try {
                // Check if binary is already signed and valid
                execSync(`codesign -v "${binaryPath}"`, { stdio: 'pipe' });

                // Check for quarantine attributes
                const xattr = execSync(`xattr "${binaryPath}" 2>/dev/null`, { encoding: 'utf8' });
                is_needs = xattr.includes('com.apple.quarantine');
            } catch (error) {
                // Signature verification failed or quarantine exists
                is_needs = true;
            }
        }
    }
    return is_needs;
}

/**
 * Automatically sign a binary with ad-hoc signature and remove quarantine
 * @param binaryPath Absolute path to the binary
 * @returns true if signing succeeded, false otherwise
 */
export function autoSignBinary(binaryPath: string): boolean {
    let success = true;
    if (process.platform === 'darwin') {
        if (needsSigning(binaryPath)) {
            try {
                console.log(`Auto-signing binary: ${path.basename(binaryPath)}...`);

                // Step 1: Remove quarantine attribute if present
                try {
                    execSync(`xattr -d com.apple.quarantine "${binaryPath}" 2>/dev/null`, { stdio: 'pipe' });
                    console.log('  ✓ Removed quarantine attribute');
                } catch (error) {
                    // Quarantine attribute might not exist, that's OK
                }

                // Step 2: Apply ad-hoc signature
                execSync(`codesign -s - -f "${binaryPath}"`, { stdio: 'pipe' });
                console.log('  ✓ Applied ad-hoc signature');

                // Step 3: Verify signature
                execSync(`codesign -v "${binaryPath}"`, { stdio: 'pipe' });
                console.log('  ✓ Signature verified');
            } catch (error: any) {
                console.error(`Failed to sign binary ${path.basename(binaryPath)}:`, error.message);
                success = false;
            }
        }
    }
    return success;
}

/**
 * Auto-sign all binaries in a directory
 * @param dirPath Directory containing binaries
 * @param pattern Optional filename pattern (e.g., "*.node")
 * @returns Number of successfully signed binaries
 */
export function autoSignDirectory(dirPath: string, pattern = '*.node'): number {
    if (process.platform !== 'darwin') {
        return 0;
    }

    if (!fs.existsSync(dirPath)) {
        return 0;
    }

    let signedCount = 0;
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
        if (pattern === '*.node' && !file.endsWith('.node')) {
            continue;
        }

        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);

        if (stats.isFile() && autoSignBinary(filePath)) {
            signedCount++;
        }
    }

    return signedCount;
}
