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

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// In-memory storage for version info (use database in production)
let versionData = {
  currentVersion: null,
  minVersion: null,
  filename: null,
  uploadDate: null
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Keep original filename with timestamp to prevent conflicts
    const timestamp = Date.now();
    const originalName = file.originalname;
    cb(null, `${timestamp}-${originalName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB limit
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.exe') {
      cb(null, true);
    } else {
      cb(new Error('Only .exe files are allowed'));
    }
  }
});

// Dashboard page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Upload endpoint with progress tracking
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { currentVersion, minVersion } = req.body;

    if (!currentVersion || !minVersion) {
      // Delete uploaded file if validation fails
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ 
        error: 'Current version and minimum version are required' 
      });
    }

    // Delete old file if exists
    if (versionData.filename) {
      const oldFilePath = path.join(uploadsDir, versionData.filename);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }

    // Update version data
    versionData = {
      currentVersion,
      minVersion,
      filename: req.file.filename,
      originalName: req.file.originalname,
      uploadDate: new Date().toISOString(),
      fileSize: req.file.size
    };

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
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
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
    needsUpdate, // Must update (below min version)
    hasUpdate, // Update available
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