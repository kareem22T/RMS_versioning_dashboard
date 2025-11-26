// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose(); // Import sqlite3

const app = express();
const PORT = 5100;
const DB_PATH = path.join(__dirname, 'version_data.db'); // Path to SQLite file

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const tempDir = path.join(__dirname, 'temp');
[uploadsDir, tempDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// --- SQLite Database Setup ---
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error connecting to SQLite database:', err.message);
    process.exit(1); // Exit if DB connection fails
  }
  console.log('Connected to the SQLite database.');
  
  // Create versions table if it doesn't exist
  db.run(`CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY,
    currentVersion TEXT NOT NULL,
    minVersion TEXT NOT NULL,
    filename TEXT NOT NULL UNIQUE,
    originalName TEXT NOT NULL,
    uploadDate TEXT NOT NULL,
    fileSize INTEGER NOT NULL
  )`, (err) => {
    if (err) {
      console.error('Error creating versions table:', err.message);
    } else {
      console.log('Versions table initialized.');
    }
  });
});

// Helper function to get the latest version data
function getLatestVersion() {
  return new Promise((resolve, reject) => {
    // Select the latest version (highest id, assuming auto-increment)
    const sql = `SELECT * FROM versions ORDER BY id DESC LIMIT 1`;
    db.get(sql, [], (err, row) => {
      if (err) {
        return reject(err);
      }
      // If row is undefined, it means no version is available.
      resolve(row);
    });
  });
}
// -----------------------------

// Configure multer for chunk uploads
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    const { fileId, chunkIndex } = req.body;
    cb(null, `${fileId}-chunk-${chunkIndex}`);
  }
});

const uploadChunk = multer({
  storage: chunkStorage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB per chunk
});

// Dashboard page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize chunked upload
app.post('/api/upload/init', (req, res) => {
  try {
    const { fileName, fileSize, totalChunks, currentVersion, minVersion } = req.body;

    if (!fileName || !fileSize || !totalChunks || !currentVersion || !minVersion) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate version format
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(currentVersion) || !versionRegex.test(minVersion)) {
      return res.status(400).json({ 
        error: 'Version format must be X.Y.Z (e.g., 1.3.2)' 
      });
    }

    // Validate file extension
    if (!fileName.toLowerCase().endsWith('.exe')) {
      return res.status(400).json({ error: 'Only .exe files are allowed' });
    }

    const fileId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    // Store metadata
    const metadata = {
      fileId,
      fileName,
      fileSize,
      totalChunks,
      currentVersion,
      minVersion,
      uploadedChunks: [],
      createdAt: new Date().toISOString()
    };
    
    fs.writeFileSync(
      path.join(tempDir, `${fileId}-metadata.json`),
      JSON.stringify(metadata)
    );

    res.json({ 
      fileId, 
      message: 'Upload session initialized' 
    });
  } catch (error) {
    console.error('Init error:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
  }
});

// Upload individual chunk
app.post('/api/upload/chunk', uploadChunk.single('chunk'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No chunk uploaded' });
    }

    const { fileId, chunkIndex } = req.body;
    const metadataPath = path.join(tempDir, `${fileId}-metadata.json`);

    if (!fs.existsSync(metadataPath)) {
      // Clean up uploaded chunk
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Upload session not found' });
    }

    // Update metadata
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (!metadata.uploadedChunks.includes(parseInt(chunkIndex))) {
      metadata.uploadedChunks.push(parseInt(chunkIndex));
    }
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));

    res.json({
      success: true,
      chunkIndex: parseInt(chunkIndex),
      uploadedChunks: metadata.uploadedChunks.length,
      totalChunks: metadata.totalChunks
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

// Finalize upload (merge chunks)
app.post('/api/upload/finalize', async (req, res) => {
  try {
    const { fileId } = req.body;
    const metadataPath = path.join(tempDir, `${fileId}-metadata.json`);

    if (!fs.existsSync(metadataPath)) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

    // Check all chunks uploaded
    if (metadata.uploadedChunks.length !== metadata.totalChunks) {
      return res.status(400).json({
        error: 'Not all chunks uploaded',
        uploaded: metadata.uploadedChunks.length,
        total: metadata.totalChunks
      });
    }

    // Get current version to delete old file
    const currentVersionData = await getLatestVersion();

    // Delete old version file if exists
    if (currentVersionData && currentVersionData.filename) {
      const oldFilePath = path.join(uploadsDir, currentVersionData.filename);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
        console.log(`Deleted old file: ${currentVersionData.filename}`);
      }
    }

    // Merge chunks
    const timestamp = Date.now();
    const finalFilename = `${timestamp}-${metadata.fileName}`;
    const finalPath = path.join(uploadsDir, finalFilename);
    const writeStream = fs.createWriteStream(finalPath);

    // Sort chunks by index
    metadata.uploadedChunks.sort((a, b) => a - b);

    for (const chunkIndex of metadata.uploadedChunks) {
      const chunkPath = path.join(tempDir, `${fileId}-chunk-${chunkIndex}`);
      if (fs.existsSync(chunkPath)) {
        const chunkBuffer = fs.readFileSync(chunkPath);
        writeStream.write(chunkBuffer);
        fs.unlinkSync(chunkPath); // Delete chunk after merging
      }
    }

    writeStream.end();

    // Wait for write to complete
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // --- Update SQLite Database ---
    const newVersionData = {
      currentVersion: metadata.currentVersion,
      minVersion: metadata.minVersion,
      filename: finalFilename,
      originalName: metadata.fileName,
      uploadDate: new Date().toISOString(),
      fileSize: metadata.fileSize
    };
    
    // Insert new version data into the database
    const insertSql = `INSERT INTO versions 
      (currentVersion, minVersion, filename, originalName, uploadDate, fileSize) 
      VALUES (?, ?, ?, ?, ?, ?)`;
      
    db.run(insertSql, [
      newVersionData.currentVersion, 
      newVersionData.minVersion, 
      newVersionData.filename, 
      newVersionData.originalName, 
      newVersionData.uploadDate, 
      newVersionData.fileSize
    ], function(err) {
      if (err) {
        console.error('DB Insert Error:', err.message);
        // Continue to respond, but log the DB error
      } else {
        console.log(`New version added with ID: ${this.lastID}`);
      }
    });
    // --------------------------------

    // Clean up metadata
    fs.unlinkSync(metadataPath);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        currentVersion: newVersionData.currentVersion,
        minVersion: newVersionData.minVersion,
        filename: newVersionData.originalName,
        uploadDate: newVersionData.uploadDate
      }
    });
  } catch (error) {
    console.error('Finalize error:', error);
    res.status(500).json({ error: 'Failed to finalize upload' });
  }
});

// Get upload status (no change needed here)
app.get('/api/upload/status/:fileId', (req, res) => {
  try {
    const { fileId } = req.params;
    const metadataPath = path.join(tempDir, `${fileId}-metadata.json`);

    if (!fs.existsSync(metadataPath)) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const progress = (metadata.uploadedChunks.length / metadata.totalChunks * 100).toFixed(2);

    res.json({
      uploadedChunks: metadata.uploadedChunks.length,
      totalChunks: metadata.totalChunks,
      progress: parseFloat(progress)
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Get current version info
app.get('/api/version', async (req, res) => {
  try {
    const versionData = await getLatestVersion(); // Fetch from DB

    if (!versionData) {
      return res.status(404).json({ error: 'No version available' });
    }

    res.json({
      currentVersion: versionData.currentVersion,
      minVersion: versionData.minVersion,
      downloadUrl: `/api/download/${versionData.filename}`,
      uploadDate: versionData.uploadDate,
      fileSize: versionData.fileSize
    });
  } catch (error) {
    console.error('Version check error:', error);
    res.status(500).json({ error: 'Failed to retrieve version' });
  }
});

// Download endpoint
app.get('/api/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const versionData = await getLatestVersion(); // Fetch from DB

    if (!versionData || filename !== versionData.filename) {
      return res.status(404).json({ error: 'File not found' });
    }

    const filePath = path.join(uploadsDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, versionData.originalName, (err) => {
      if (err) {
        console.error('Download error:', err);
        // Check if headers already sent to avoid crashing
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        }
      }
    });
  } catch (error) {
    console.error('Download setup error:', error);
    res.status(500).json({ error: 'Download retrieval failed' });
  }
});

// Check version endpoint (for client apps to check if update needed)
app.post('/api/check-update', async (req, res) => {
  try {
    const { clientVersion } = req.body;
    const versionData = await getLatestVersion(); // Fetch from DB

    if (!versionData || !versionData.currentVersion) {
      return res.status(404).json({ error: 'No version available' });
    }

    const needsUpdate = compareVersions(clientVersion, versionData.minVersion) < 0;
    const hasUpdate = compareVersions(clientVersion, versionData.currentVersion) < 0;

    res.json({
      needsUpdate,
      hasUpdate,
      currentVersion: versionData.currentVersion,
      minVersion: versionData.minVersion,
      downloadUrl: hasUpdate ? `/api/download/${versionData.filename}` : null
    });
  } catch (error) {
    console.error('Check update error:', error);
    res.status(500).json({ error: 'Failed to check update' });
  }
});

// Simple version comparison (semantic versioning)
function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;
    
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  
  return 0;
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Closed the SQLite database connection.');
    process.exit(0);
  });
});