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
    if (process.platform !== 'darwin') {
        return false;
    }

    if (!fs.existsSync(binaryPath)) {
        return false;
    }

    try {
        // Check if binary is already signed and valid
        execSync(`codesign -v "${binaryPath}"`, { stdio: 'pipe' });

        // Check for quarantine attributes
        const xattr = execSync(`xattr "${binaryPath}" 2>/dev/null`, { encoding: 'utf8' });
        if (xattr.includes('com.apple.quarantine')) {
            return true; // Needs quarantine removal
        }

        return false; // Already signed and no quarantine
    } catch (error) {
        // Signature verification failed or quarantine exists
        return true;
    }
}

/**
 * Automatically sign a binary with ad-hoc signature and remove quarantine
 * @param binaryPath Absolute path to the binary
 * @returns true if signing succeeded, false otherwise
 */
export function autoSignBinary(binaryPath: string): boolean {
    if (process.platform !== 'darwin') {
        return true; // No signing needed on non-macOS
    }

    if (!needsSigning(binaryPath)) {
        console.log(`Binary already signed: ${path.basename(binaryPath)}`);
        return true;
    }

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

        return true;
    } catch (error: any) {
        console.error(`Failed to sign binary ${path.basename(binaryPath)}:`, error.message);
        return false;
    }
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
