// server.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 5100;

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

// In-memory storage for version info (use database in production)
let versionData = {
  currentVersion: null,
  minVersion: null,
  filename: null,
  uploadDate: null
};

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

    // Delete old version file if exists
    if (versionData.filename) {
      const oldFilePath = path.join(uploadsDir, versionData.filename);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
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

    // Update version data
    versionData = {
      currentVersion: metadata.currentVersion,
      minVersion: metadata.minVersion,
      filename: finalFilename,
      originalName: metadata.fileName,
      uploadDate: new Date().toISOString(),
      fileSize: metadata.fileSize
    };

    // Clean up metadata
    fs.unlinkSync(metadataPath);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        currentVersion: versionData.currentVersion,
        minVersion: versionData.minVersion,
        filename: versionData.originalName,
        uploadDate: versionData.uploadDate
      }
    });
  } catch (error) {
    console.error('Finalize error:', error);
    res.status(500).json({ error: 'Failed to finalize upload' });
  }
});

// Get upload status
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
app.get('/api/version', (req, res) => {
  if (!versionData.currentVersion) {
    return res.status(404).json({ error: 'No version available' });
  }

  res.json({
    currentVersion: versionData.currentVersion,
    minVersion: versionData.minVersion,
    downloadUrl: `/api/download/${versionData.filename}`,
    uploadDate: versionData.uploadDate,
    fileSize: versionData.fileSize
  });
});

// Download endpoint
app.get('/api/download/:filename', (req, res) => {
  const filename = req.params.filename;
  
  if (filename !== versionData.filename) {
    return res.status(404).json({ error: 'File not found' });
  }

  const filePath = path.join(uploadsDir, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, versionData.originalName, (err) => {
    if (err) {
      console.error('Download error:', err);
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

// Check version endpoint (for client apps to check if update needed)
app.post('/api/check-update', (req, res) => {
  const { clientVersion } = req.body;

  if (!versionData.currentVersion) {
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