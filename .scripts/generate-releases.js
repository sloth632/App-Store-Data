#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Function to recursively find all metadata.json files
function findMetadataFiles(dir) {
    const metadataFiles = [];

    if (!fs.existsSync(dir)) {
        return metadataFiles;
    }

    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
        const fullPath = path.join(dir, item.name);

        if (item.isDirectory()) {
            // Recursively search subdirectories
            metadataFiles.push(...findMetadataFiles(fullPath));
        } else if (item.name === 'metadata.json') {
            metadataFiles.push(fullPath);
        }
    }

    return metadataFiles;
}

// Function to load and validate metadata
function loadMetadata(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const metadata = JSON.parse(content);

        // Basic validation - ensure required fields exist
        const requiredFields = ['name', 'category', 'description', 'version', 'commit', 'owner', 'repo', 'path'];
        for (const field of requiredFields) {
            if (!(field in metadata) || metadata[field] === null || metadata[field] === undefined || metadata[field] === '') {
                console.warn(`⚠️ Skipping ${filePath}: missing or empty field '${field}'`);
                return null;
            }
        }

        // Add file path for reference
        metadata.filePath = path.dirname(filePath).replace(/\\/g, '/');

        return metadata;
    } catch (error) {
        console.warn(`⚠️ Skipping ${filePath}: ${error.message}`);
        return null;
    }
}

// Function to load valid categories
function loadValidCategories() {
    try {
        const categoriesPath = path.join(__dirname, '..', 'categories.json');
        const categoriesContent = fs.readFileSync(categoriesPath, 'utf8');
        return JSON.parse(categoriesContent);
    } catch (error) {
        console.warn(`⚠️ Could not load categories.json: ${error.message}`);
        return [];
    }
}

// Main function
async function main() {
    console.log('🔄 Generating release files...');

    // Load valid categories
    const validCategories = loadValidCategories();
    console.log(`📋 Valid categories: ${validCategories.join(', ')}`);

    // Find all metadata files
    const repositoriesDir = path.join(__dirname, '..', 'repositories');
    const metadataFiles = findMetadataFiles(repositoriesDir);
    console.log(`📁 Found ${metadataFiles.length} metadata files`);

    if (metadataFiles.length === 0) {
        console.log('ℹ️ No metadata files found. No release files will be generated.');
        return;
    }

    // Group metadata by category
    const categorizedApps = {};
    let processedCount = 0;
    let skippedCount = 0;

    for (const filePath of metadataFiles) {
        const metadata = loadMetadata(filePath);
        if (metadata) {
            const category = metadata.category;

            if (!categorizedApps[category]) {
                categorizedApps[category] = [];
            }

            categorizedApps[category].push(metadata);
            processedCount++;
            console.log(`✅ Added ${metadata.name} to category '${category}'`);
        } else {
            skippedCount++;
        }
    }

    console.log(`📊 Processed: ${processedCount}, Skipped: ${skippedCount}`);

    // Create releases directory if it doesn't exist
    const releasesDir = path.join(__dirname, '..', 'releases');
    if (!fs.existsSync(releasesDir)) {
        fs.mkdirSync(releasesDir, { recursive: true });
        console.log(`📁 Created releases directory`);
    }

    // Generate release files for each category
    const releaseFiles = [];
    const categoriesWithReleases = [];
    for (const [category, apps] of Object.entries(categorizedApps)) {
        const releaseFileName = `category-${category.toLowerCase().replace(/[^a-z0-9]/g, '-')}.json`;
        const releaseFilePath = path.join(releasesDir, releaseFileName);

        // Sort apps by name for consistent ordering
        apps.sort((a, b) => a.name.localeCompare(b.name));

        // Filter out unwanted fields from apps for category files
        const filteredApps = apps.map(app => {
            const { commit, owner, repo, path, filePath, category, files, ...cleanApp } = app;
            // Add slug in format: owner/repo/appname
            cleanApp.slug = `${owner}/${repo}/${app.name}`;

            // Include supported-devices if present (apps/scripts only, not themes)
            const isTheme = app.category === 'Themes';
            if (app['supported-devices'] && !isTheme) {
                cleanApp['supported-devices'] = app['supported-devices'];
            }

            // Include supported-screen-size if present (themes only)
            if (app['supported-screen-size'] && isTheme) {
                cleanApp['supported-screen-size'] = app['supported-screen-size'];
            }

            return cleanApp;
        });

        const releaseData = {
            category: category,
            count: apps.length,
            apps: filteredApps
        };

        try {
            // Check if file content has actually changed before writing
            let shouldWriteFile = true;
            if (fs.existsSync(releaseFilePath)) {
                const existingContent = fs.readFileSync(releaseFilePath, 'utf8');
                const newContent = JSON.stringify(releaseData, null, 2);
                shouldWriteFile = existingContent !== newContent;
            }

            if (shouldWriteFile) {
                // Write with pretty formatting
                fs.writeFileSync(releaseFilePath, JSON.stringify(releaseData, null, 2), 'utf8');
                console.log(`📄 Generated ${releaseFileName} with ${apps.length} apps (content changed)`);
            } else {
                console.log(`📄 Skipped ${releaseFileName} with ${apps.length} apps (no content change)`);
            }
            
            releaseFiles.push(releaseFileName);
            categoriesWithReleases.push(category);
        } catch (error) {
            console.error(`❌ Failed to write ${releaseFileName}: ${error.message}`);
        }
    }

    // Commit only the category files that actually changed
    try {
        console.log('📝 Committing changed category files to git...');
        
        // Check which files actually have changes
        const gitStatus = execSync('git status --porcelain releases/category-*.json', { 
            encoding: 'utf8', 
            cwd: path.join(__dirname, '..') 
        }).trim();
        
        if (gitStatus) {
            // Add and commit only the changed files
            execSync('git add releases/category-*.json', { cwd: path.join(__dirname, '..') });
            execSync('git commit -m "Update category release files"', { cwd: path.join(__dirname, '..') });
            console.log('✅ Changed category files committed to git');
            console.log('📋 Changed files:', gitStatus.split('\n').map(line => line.trim()).join(', '));
        } else {
            console.log('ℹ️ No changes to commit for category files');
        }
    } catch (gitError) {
        console.warn('⚠️ Could not commit category files to git:', gitError.message);
    }

    // Generate categories.json with timestamps from git history
    if (categoriesWithReleases.length > 0) {
        const categoriesFilePath = path.join(releasesDir, 'categories.json');
        
        // Create categories array with counts and timestamps from existing git history
        const categoriesWithTimestamps = categoriesWithReleases.map(category => {
            const categorySlug = category.toLowerCase().replace(/[^a-z0-9]/g, '-');
            const categoryFileName = `category-${categorySlug}.json`;
            
            let lastUpdated = Math.floor(Date.now() / 1000); // Default to current time
            
            try {
                // Get the last commit timestamp when this specific category file was modified
                const gitCommand = `git log -1 --format=%ct --follow -- "releases/${categoryFileName}"`;
                const result = execSync(gitCommand, {
                    encoding: 'utf8',
                    stdio: 'pipe',
                    cwd: path.join(__dirname, '..')
                }).trim();
                
                if (result) {
                    lastUpdated = parseInt(result);
                    console.log(`📅 Category ${category}: ${lastUpdated} (${new Date(lastUpdated * 1000).toISOString()})`);
                } else {
                    console.warn(`⚠️ No git history found for ${categoryFileName}, using current time`);
                }
            } catch (gitError) {
                console.warn(`⚠️ Could not get git timestamp for ${categoryFileName}: ${gitError.message}`);
            }
            
            return {
                name: category,
                slug: categorySlug,
                count: categorizedApps[category].length,
                lastUpdated: lastUpdated
            };
        }).sort((a, b) => a.name.localeCompare(b.name));
        
        const categoriesData = {
            totalCategories: categoriesWithReleases.length,
            totalApps: Object.values(categorizedApps).reduce((sum, apps) => sum + apps.length, 0),
            lastUpdated: Math.floor(Date.now() / 1000),
            categories: categoriesWithTimestamps
        };
        
        try {
            fs.writeFileSync(categoriesFilePath, JSON.stringify(categoriesData, null, 2), 'utf8');
            console.log(`📄 Generated categories.json with ${categoriesWithReleases.length} categories`);
            
            // Commit categories.json
            try {
                execSync('git add releases/categories.json', { cwd: path.join(__dirname, '..') });
                const categoriesGitStatus = execSync('git status --porcelain releases/categories.json', { 
                    encoding: 'utf8', 
                    cwd: path.join(__dirname, '..') 
                }).trim();
                
                if (categoriesGitStatus) {
                    execSync('git commit -m "Update categories.json with timestamps"', { cwd: path.join(__dirname, '..') });
                    console.log('✅ categories.json committed to git');
                } else {
                    console.log('ℹ️ No changes to commit for categories.json');
                }
            } catch (categoriesGitError) {
                console.warn('⚠️ Could not commit categories.json to git:', categoriesGitError.message);
            }
        } catch (error) {
            console.error(`❌ Failed to write categories.json: ${error.message}`);
        }
    }

    // Clean up old release files that are no longer needed
    const existingReleaseFiles = fs.readdirSync(releasesDir)
        .filter(file => file.startsWith('category-') && file.endsWith('.json'));

    for (const existingFile of existingReleaseFiles) {
        if (!releaseFiles.includes(existingFile)) {
            try {
                fs.unlinkSync(path.join(releasesDir, existingFile));
                console.log(`🗑️ Removed obsolete file: ${existingFile}`);
            } catch (error) {
                console.warn(`⚠️ Could not remove ${existingFile}: ${error.message}`);
            }
        }
    }

    // Generate summary
    console.log('');
    console.log('📋 Summary:');
    console.log(`   Categories: ${Object.keys(categorizedApps).length}`);
    console.log(`   Total apps: ${processedCount}`);
    console.log(`   Release files: ${releaseFiles.length}`);

    if (releaseFiles.length > 0) {
        console.log('');
        console.log('📄 Generated files:');
        for (const file of releaseFiles) {
            console.log(`   - ${file}`);
        }
    }

    console.log('✅ Release file generation complete!');
}

// Run the script
main().catch(error => {
    console.error('❌ Script failed:', error);
    process.exit(1);
});