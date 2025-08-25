// server.js - Complete surveillance data processing server with image support
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const csv = require('csv-parser');
const { createReadStream } = require('fs');

const app = express();
const PORT = process.env.PORT || 8081;

// Your data directory path
const DATA_PATH = '/home/shanks/Music/01-01-70-01-10-47-835';

// Enable CORS for all routes
app.use(cors({
  origin: true,
  methods: ['GET', 'HEAD', 'OPTIONS', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Cache-Control', 'Range'],
  credentials: false,
  optionsSuccessStatus: 200
}));

// Parse JSON bodies
app.use(express.json());

// Add security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Utility function to read CSV files
const readCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    
    if (!fsSync.existsSync(filePath)) {
      reject(new Error(`File not found: ${filePath}`));
      return;
    }

    createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
};

// Utility function to scan for all metadata.csv files
const scanForMetadataFiles = async (basePath) => {
  const metadataFiles = [];
  
  const scanDirectory = async (dirPath, relativePath = '') => {
    try {
      const items = await fs.readdir(dirPath);
      
      for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const relPath = path.join(relativePath, item);
        const stat = await fs.stat(fullPath);
        
        if (stat.isDirectory()) {
          // Recursively scan subdirectories
          await scanDirectory(fullPath, relPath);
        } else if (item === 'metadata.csv') {
          const pathParts = relativePath.split(path.sep);
          
          // Handle different directory structures
          let session, camera, anomalyType;
          
          if (pathParts.length >= 3) {
            // Structure: session/camera/class/metadata.csv
            session = pathParts[0];
            camera = pathParts[1];
            anomalyType = pathParts[2];
          } else if (pathParts.length === 2) {
            // Structure: session/camera/metadata.csv (general class)
            session = pathParts[0];
            camera = pathParts[1];
            anomalyType = 'general';
          } else {
            // Fallback
            session = pathParts[0] || 'unknown';
            camera = 'unknown';
            anomalyType = 'general';
          }
          
          metadataFiles.push({
            path: fullPath,
            relativePath: relPath,
            session,
            camera,
            anomalyType,
            depth: pathParts.length
          });
          
          console.log(`Found metadata.csv: ${session}/${camera}/${anomalyType}`);
        }
      }
    } catch (error) {
      console.error(`Error scanning directory ${dirPath}:`, error.message);
    }
  };
  
  await scanDirectory(basePath);
  
  // Sort by session, camera, then anomaly type for consistent ordering
  metadataFiles.sort((a, b) => {
    if (a.session !== b.session) return a.session.localeCompare(b.session);
    if (a.camera !== b.camera) return a.camera.localeCompare(b.camera);
    return a.anomalyType.localeCompare(b.anomalyType);
  });
  
  console.log(`Found ${metadataFiles.length} metadata.csv files total`);
  return metadataFiles;
};

// Utility function to get images for a directory
const getImagesInDirectory = async (dirPath) => {
  try {
    const items = await fs.readdir(dirPath);
    const imageFiles = [];
    
    for (const item of items) {
      try {
        const itemPath = path.join(dirPath, item);
        const itemStat = await fs.stat(itemPath);
        
        // Filter for image files
        if (itemStat.isFile() && /\.(jpg|jpeg|png|bmp|gif|webp)$/i.test(item)) {
          imageFiles.push({
            name: item,
            size: itemStat.size,
            modified: itemStat.mtime
          });
        }
      } catch (error) {
        console.error(`Error reading ${item}:`, error.message);
      }
    }
    
    // Sort by name
    return imageFiles.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    return [];
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Surveillance server is running' });
});

// Get GPS data from F2/gps_log.csv
app.get('/api/gps-data', async (req, res) => {
  try {
    const gpsPath = path.join(DATA_PATH, 'F2', 'gps_log.csv');
    const gpsData = await readCSV(gpsPath);
    
    res.json({
      success: true,
      count: gpsData.length,
      data: gpsData,
      metadata: {
        source: 'F2/gps_log.csv',
        type: 'GPS tracking data'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to read GPS data'
    });
  }
});

// Get system metrics from floMobility123_F1/system_metrics.csv
app.get('/api/system-metrics', async (req, res) => {
  try {
    const metricsPath = path.join(DATA_PATH, 'floMobility123_F1', 'system_metrics.csv');
    const metricsData = await readCSV(metricsPath);
    
    res.json({
      success: true,
      count: metricsData.length,
      data: metricsData,
      metadata: {
        source: 'floMobility123_F1/system_metrics.csv',
        type: 'System performance metrics'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to read system metrics'
    });
  }
});

// Get all metadata files information with image counts
app.get('/api/metadata/scan', async (req, res) => {
  try {
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    
  // Enhanced scan that includes image information
    const enhancedFiles = [];
    for (const file of metadataFiles) {
      // Look for images in the images/ subdirectory
      const imagesPath = path.join(path.dirname(file.path), 'images');
      const images = await getImagesInDirectory(imagesPath);
      
      enhancedFiles.push({
        session: file.session,
        camera: file.camera,
        anomalyType: file.anomalyType,
        path: file.relativePath,
        imageCount: images.length,
        hasImages: images.length > 0,
        sampleImages: images.slice(0, 3).map(img => img.name),
        imagesPath: `${file.session}/${file.camera}/${file.anomalyType}/images/`
      });
    }
    
    res.json({
      success: true,
      count: enhancedFiles.length,
      files: enhancedFiles
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to scan metadata files'
    });
  }
});

// Get images for a specific session/camera/class combination
app.get('/api/images/:session/:camera/:anomalyType', async (req, res) => {
  try {
    const { session, camera, anomalyType } = req.params;
    // Images are stored in images/ subdirectory within each class folder
    const imagesPath = path.join(DATA_PATH, session, camera, anomalyType, 'images');
    
    console.log(`Looking for images in: ${imagesPath}`);
    
    // Check if images directory exists
    try {
      await fs.access(imagesPath);
    } catch (error) {
      console.log(`Images directory not found: ${imagesPath}`);
      return res.status(404).json({
        success: false,
        error: `Images directory not found: ${session}/${camera}/${anomalyType}/images`,
        message: 'Images directory does not exist',
        expectedPath: `${session}/${camera}/${anomalyType}/images`
      });
    }
    
    const imageFiles = await getImagesInDirectory(imagesPath);
    console.log(`Found ${imageFiles.length} images in ${imagesPath}`);
    
    res.json({
      success: true,
      session,
      camera,
      anomalyType,
      count: imageFiles.length,
      images: imageFiles.map(img => ({
        ...img,
        // Images are served from the images subdirectory
        url: `/data/${session}/${camera}/${anomalyType}/images/${img.name}`
      })),
      metadata: {
        source: `${session}/${camera}/${anomalyType}/images/`,
        type: 'Image files'
      }
    });
    
  } catch (error) {
    console.error(`Error getting images for ${req.params.session}/${req.params.camera}/${req.params.anomalyType}:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: `Failed to get images for ${req.params.session}/${req.params.camera}/${req.params.anomalyType}`
    });
  }
});

// Enhanced metadata endpoint that includes image information
app.get('/api/metadata-with-images/:session/:camera/:anomalyType', async (req, res) => {
  try {
    const { session, camera, anomalyType } = req.params;
    const metadataPath = path.join(DATA_PATH, session, camera, anomalyType, 'metadata.csv');
    // Images are in images/ subdirectory
    const imagesPath = path.join(DATA_PATH, session, camera, anomalyType, 'images');
    
    // Load metadata
    let metadataData = [];
    try {
      metadataData = await readCSV(metadataPath);
    } catch (error) {
      console.warn(`No metadata.csv found for ${session}/${camera}/${anomalyType}`);
    }
    
    // Load images from images/ subdirectory
    const imageFiles = await getImagesInDirectory(imagesPath);
    
    res.json({
      success: true,
      session,
      camera,
      anomalyType,
      metadata: {
        count: metadataData.length,
        data: metadataData
      },
      images: {
        count: imageFiles.length,
        data: imageFiles.map(img => ({
          ...img,
          // Images are served from the images subdirectory
          url: `/data/${session}/${camera}/${anomalyType}/images/${img.name}`
        }))
      },
      source: `${session}/${camera}/${anomalyType}/`
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: `Failed to get metadata and images for ${req.params.session}/${req.params.camera}/${req.params.anomalyType}`
    });
  }
});

// Get specific metadata by session, camera, and anomaly type
app.get('/api/metadata/:session/:camera/:anomalyType', async (req, res) => {
  try {
    const { session, camera, anomalyType } = req.params;
    const metadataPath = path.join(DATA_PATH, session, camera, anomalyType, 'metadata.csv');
    
    const metadataData = await readCSV(metadataPath);
    
    res.json({
      success: true,
      count: metadataData.length,
      data: metadataData,
      metadata: {
        session,
        camera,
        anomalyType,
        source: `${session}/${camera}/${anomalyType}/metadata.csv`
      }
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message,
      message: `Metadata not found for ${req.params.session}/${req.params.camera}/${req.params.anomalyType}`
    });
  }
});

// Get all anomalies for a specific camera across all sessions
app.get('/api/camera/:camera/anomalies', async (req, res) => {
  try {
    const { camera } = req.params;
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    const cameraFiles = metadataFiles.filter(file => file.camera === camera);
    
    const anomalies = [];
    for (const file of cameraFiles) {
      try {
        const data = await readCSV(file.path);
        // Look for images in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        
        anomalies.push({
          session: file.session,
          anomalyType: file.anomalyType,
          count: data.length,
          imageCount: images.length,
          data: data,
          images: images.slice(0, 5) // First 5 images as preview
        });
      } catch (error) {
        console.error(`Error reading ${file.path}:`, error.message);
      }
    }
    
    res.json({
      success: true,
      camera,
      anomalyCount: anomalies.length,
      anomalies
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: `Failed to get anomalies for camera ${req.params.camera}`
    });
  }
});

// Get dashboard summary with all data including images
app.get('/api/dashboard', async (req, res) => {
  try {
    const dashboard = {
      success: true,
      timestamp: new Date().toISOString(),
      summary: {}
    };

    // GPS Data
    try {
      const gpsPath = path.join(DATA_PATH, 'F2', 'gps_log.csv');
      const gpsData = await readCSV(gpsPath);
      dashboard.summary.gps = {
        available: true,
        recordCount: gpsData.length,
        lastRecord: gpsData[gpsData.length - 1] || null
      };
    } catch (error) {
      dashboard.summary.gps = { available: false, error: error.message };
    }

    // System Metrics
    try {
      const metricsPath = path.join(DATA_PATH, 'floMobility123_F1', 'system_metrics.csv');
      const metricsData = await readCSV(metricsPath);
      dashboard.summary.systemMetrics = {
        available: true,
        recordCount: metricsData.length,
        lastRecord: metricsData[metricsData.length - 1] || null
      };
    } catch (error) {
      dashboard.summary.systemMetrics = { available: false, error: error.message };
    }

    // Anomaly Detection Summary with Images
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    const anomalySummary = {};
    let totalImages = 0;
    
    for (const file of metadataFiles) {
      try {
        const data = await readCSV(file.path);
        // Look for images in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        totalImages += images.length;
        
        if (!anomalySummary[file.camera]) {
          anomalySummary[file.camera] = {};
        }
        
        anomalySummary[file.camera][file.anomalyType] = {
          session: file.session,
          recordCount: data.length,
          imageCount: images.length,
          lastDetection: data[data.length - 1] || null,
          sampleImages: images.slice(0, 3).map(img => ({
            name: img.name,
            // Images are served from images subdirectory
            url: `/data/${file.session}/${file.camera}/${file.anomalyType}/images/${img.name}`
          }))
        };
      } catch (error) {
        console.error(`Error processing ${file.path}:`, error.message);
      }
    }
    
    dashboard.summary.anomalies = anomalySummary;
    dashboard.summary.totalMetadataFiles = metadataFiles.length;
    dashboard.summary.totalImages = totalImages;

    res.json(dashboard);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to generate dashboard'
    });
  }
});

// Get anomalies by type across all cameras
app.get('/api/anomalies/:anomalyType', async (req, res) => {
  try {
    const { anomalyType } = req.params;
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    const anomalyFiles = metadataFiles.filter(file => file.anomalyType === anomalyType);
    
    const results = [];
    for (const file of anomalyFiles) {
      try {
        const data = await readCSV(file.path);
        // Look for images in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        
        results.push({
          session: file.session,
          camera: file.camera,
          count: data.length,
          imageCount: images.length,
          data: data,
          images: images.slice(0, 5)
        });
      } catch (error) {
        console.error(`Error reading ${file.path}:`, error.message);
      }
    }
    
    res.json({
      success: true,
      anomalyType,
      cameraCount: results.length,
      totalDetections: results.reduce((sum, r) => sum + r.count, 0),
      totalImages: results.reduce((sum, r) => sum + r.imageCount, 0),
      cameras: results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: `Failed to get ${req.params.anomalyType} anomalies`
    });
  }
});

// Search functionality
app.get('/api/search', async (req, res) => {
  try {
    const { 
      session, 
      camera, 
      anomalyType, 
      startDate, 
      endDate,
      limit = 100 
    } = req.query;
    
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    let filteredFiles = metadataFiles;
    
    // Apply filters
    if (session) {
      filteredFiles = filteredFiles.filter(f => f.session === session);
    }
    if (camera) {
      filteredFiles = filteredFiles.filter(f => f.camera === camera);
    }
    if (anomalyType) {
      filteredFiles = filteredFiles.filter(f => f.anomalyType === anomalyType);
    }
    
    const results = [];
    for (const file of filteredFiles.slice(0, parseInt(limit))) {
      try {
        let data = await readCSV(file.path);
        
        // Apply date filters if provided
        if (startDate || endDate) {
          data = data.filter(record => {
            const timestamp = record.timestamp || record.date || record.created_at;
            if (!timestamp) return true;
            
            const recordDate = new Date(timestamp);
            if (startDate && recordDate < new Date(startDate)) return false;
            if (endDate && recordDate > new Date(endDate)) return false;
            return true;
          });
        }
        
        // Get images for this result - look in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        
        results.push({
          session: file.session,
          camera: file.camera,
          anomalyType: file.anomalyType,
          count: data.length,
          imageCount: images.length,
          data: data,
          images: images.slice(0, 5)
        });
      } catch (error) {
        console.error(`Error reading ${file.path}:`, error.message);
      }
    }
    
    res.json({
      success: true,
      filters: { session, camera, anomalyType, startDate, endDate, limit },
      resultCount: results.length,
      totalRecords: results.reduce((sum, r) => sum + r.count, 0),
      totalImages: results.reduce((sum, r) => sum + r.imageCount, 0),
      results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Search failed'
    });
  }
});

// Serve static files from data directory (IMAGES SERVED HERE)
app.use('/data', express.static(DATA_PATH, {
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    
    if (filePath.endsWith('.csv')) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    } else if (filePath.match(/\.(jpg|jpeg)$/i)) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (filePath.endsWith('.gif')) {
      res.setHeader('Content-Type', 'image/gif');
    } else if (filePath.endsWith('.webp')) {
      res.setHeader('Content-Type', 'image/webp');
    }
    
    if (filePath.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Accept-Ranges', 'bytes');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
  index: false,
  dotfiles: 'ignore'
}));

// Directory listing endpoint
app.get('/list/:path(*)?', async (req, res) => {
  const requestedPath = req.params.path || '';
  const fullPath = path.join(DATA_PATH, requestedPath);
  
  try {
    const stat = await fs.stat(fullPath);
    
    if (stat.isDirectory()) {
      const items = await fs.readdir(fullPath);
      const files = [];
      
      for (const item of items) {
        try {
          const itemPath = path.join(fullPath, item);
          const itemStat = await fs.stat(itemPath);
          files.push({
            name: item,
            type: itemStat.isDirectory() ? 'directory' : 'file',
            size: itemStat.size,
            modified: itemStat.mtime,
            isImage: /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(item)
          });
        } catch (error) {
          console.error(`Error reading ${item}:`, error.message);
        }
      }
      
      res.json({
        path: requestedPath,
        files: files.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        })
      });
    } else {
      res.json({
        path: requestedPath,
        type: 'file',
        size: stat.size,
        modified: stat.mtime,
        isImage: /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(requestedPath)
      });
    }
  } catch (error) {
    res.status(404).json({ 
      error: 'Path not found',
      path: requestedPath,
      fullPath: fullPath 
    });
  }
});

// API documentation endpoint
app.get('/api', (req, res) => {
  res.json({
    title: 'Surveillance Data API',
    version: '2.0.0',
    endpoints: {
      health: 'GET /health - Health check',
      gps: 'GET /api/gps-data - Get GPS tracking data',
      systemMetrics: 'GET /api/system-metrics - Get system performance metrics',
      metadataScan: 'GET /api/metadata/scan - Scan for all metadata files (with image counts)',
      specificMetadata: 'GET /api/metadata/:session/:camera/:anomalyType - Get specific metadata',
      imagesList: 'GET /api/images/:session/:camera/:anomalyType - Get images for specific camera/class',
      metadataWithImages: 'GET /api/metadata-with-images/:session/:camera/:anomalyType - Get metadata and images together',
      cameraAnomalies: 'GET /api/camera/:camera/anomalies - Get all anomalies for a camera (with images)',
      anomaliesByType: 'GET /api/anomalies/:anomalyType - Get anomalies by type (with images)',
      dashboard: 'GET /api/dashboard - Get complete dashboard summary (with image info)',
      search: 'GET /api/search - Search with filters (includes image counts)',
      staticFiles: 'GET /data/... - Static file access (IMAGES SERVED HERE)',
      directoryListing: 'GET /list/... - Directory listing (with image flags)'
    },
    dataStructure: {
      sessions: ['F2', 'floMobility123_F1'],
      cameras: {
        F2: ['4kcam', 'cam1'],
        floMobility123_F1: ['argus0', 'argus1', 'cam1']
      },
      anomalyTypes: 'Dynamic - scanned from directory structure',
      mainDataFiles: ['F2/gps_log.csv', 'floMobility123_F1/system_metrics.csv'],
      imageAccess: 'GET /data/{session}/{camera}/{anomalyType}/{image.jpg}'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Surveillance Data Server running on http://localhost:${PORT}`);
  console.log(`📁 Serving data from: ${DATA_PATH}`);
  console.log(`🖼️  Images accessible at: http://localhost:${PORT}/data/{session}/{camera}/{class}/images/{image.jpg}`);
  console.log(`🌐 CORS enabled for all origins`);
  console.log(`\n📊 API Endpoints:`);
  console.log(`  - API Documentation: http://localhost:${PORT}/api`);
  console.log(`  - Health check: http://localhost:${PORT}/health`);
  console.log(`  - Dashboard: http://localhost:${PORT}/api/dashboard`);
  console.log(`  - GPS Data: http://localhost:${PORT}/api/gps-data`);
  console.log(`  - System Metrics: http://localhost:${PORT}/api/system-metrics`);
  console.log(`  - Metadata Scan: http://localhost:${PORT}/api/metadata/scan`);
  console.log(`  - Images API: http://localhost:${PORT}/api/images/{session}/{camera}/{class}`);
  console.log(`  - Search: http://localhost:${PORT}/api/search`);
  
  // Check if data directory exists
  try {
    await fs.access(DATA_PATH);
    console.log(`\n✅ Data directory found: ${DATA_PATH}`);
    
    // Perform comprehensive scan for all metadata files
    console.log(`\n🔍 Scanning for all metadata.csv files...`);
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    console.log(`📋 Found ${metadataFiles.length} metadata.csv files`);
    
    if (metadataFiles.length > 0) {
      // Group by session and camera for better logging
      const grouped = {};
      let totalImages = 0;
      
      for (const file of metadataFiles) {
        if (!grouped[file.session]) grouped[file.session] = {};
        if (!grouped[file.session][file.camera]) grouped[file.session][file.camera] = [];
        
        // Count images in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        totalImages += images.length;
        
        grouped[file.session][file.camera].push({
          anomalyType: file.anomalyType,
          imageCount: images.length
        });
      }
      
      console.log(`\n📸 Complete Camera Structure:`);
      Object.keys(grouped).forEach(session => {
        console.log(`  📁 Session: ${session}`);
        Object.keys(grouped[session]).forEach(camera => {
          const classes = grouped[session][camera];
          const totalClassImages = classes.reduce((sum, c) => sum + c.imageCount, 0);
          console.log(`    📷 ${camera}: ${classes.length} classes, ${totalClassImages} images`);
          classes.forEach(c => {
            console.log(`      - ${c.anomalyType}: ${c.imageCount} images`);
          });
        });
      });
      
      // Log unique cameras and anomaly types
      const uniqueCameras = [...new Set(metadataFiles.map(f => f.camera))];
      const uniqueAnomalyTypes = [...new Set(metadataFiles.map(f => f.anomalyType))];
      
      console.log(`\n📊 Summary:`);
      console.log(`  🎥 Total Cameras: ${uniqueCameras.length} (${uniqueCameras.join(', ')})`);
      console.log(`  🔍 Total Anomaly Types: ${uniqueAnomalyTypes.length} (${uniqueAnomalyTypes.join(', ')})`);
      console.log(`  📁 Total Sessions: ${Object.keys(grouped).length}`);
      console.log(`  🖼️  Total Images: ${totalImages}`);
    }
    
    // Check for main data files
    const mainFiles = ['F2/gps_log.csv', 'floMobility123_F1/system_metrics.csv'];
    console.log(`\n📄 Checking main data files:`);
    for (const file of mainFiles) {
      try {
        await fs.access(path.join(DATA_PATH, file));
        console.log(`  ✅ Found: ${file}`);
      } catch {
        console.log(`  ❌ Missing: ${file}`);
      }
    }
    
  } catch (error) {
    console.warn(`\n⚠️  WARNING: Data directory issue: ${error.message}`);
    console.log(`Please ensure the directory exists and contains the expected structure:`);
    console.log(`  F2/`);
    console.log(`  ├── gps_log.csv`);
    console.log(`  ├── 4kcam/[classes]/metadata.csv & images/`);
    console.log(`  └── cam1/[classes]/metadata.csv & images/`);
    console.log(`  floMobility123_F1/`);
    console.log(`  ├── system_metrics.csv`);
    console.log(`  ├── argus0/[classes]/metadata.csv & images/`);
    console.log(`  ├── argus1/[classes]/metadata.csv & images/`);
    console.log(`  └── cam1/[classes]/metadata.csv & images/`);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down surveillance server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down surveillance server...');
  process.exit(0);
});