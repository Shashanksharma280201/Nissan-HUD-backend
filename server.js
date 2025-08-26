// server.js - Complete surveillance data processing server with image support and GPS from metadata
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

// Utility function to extract GPS data from metadata records
const extractGPSData = (metadataRecords, session, camera, anomalyType) => {
  const gpsData = [];
  
  // Common GPS field names to look for
  const gpsFields = {
    latitude: ['latitude', 'lat', 'gps_lat', 'gps_latitude', 'y_coord', 'y'],
    longitude: ['longitude', 'lng', 'lon', 'gps_lng', 'gps_longitude', 'x_coord', 'x'],
    timestamp: ['timestamp', 'time', 'datetime', 'created_at', 'date', 'detection_time']
  };
  
  metadataRecords.forEach((record, index) => {
    // Find latitude field
    let lat = null;
    for (const field of gpsFields.latitude) {
      if (record[field] && record[field] !== '' && !isNaN(parseFloat(record[field]))) {
        lat = parseFloat(record[field]);
        break;
      }
    }
    
    // Find longitude field
    let lng = null;
    for (const field of gpsFields.longitude) {
      if (record[field] && record[field] !== '' && !isNaN(parseFloat(record[field]))) {
        lng = parseFloat(record[field]);
        break;
      }
    }
    
    // Find timestamp field
    let timestamp = null;
    for (const field of gpsFields.timestamp) {
      if (record[field] && record[field] !== '') {
        timestamp = record[field];
        break;
      }
    }
    
    // If we found valid GPS coordinates
    if (lat !== null && lng !== null) {
      // Basic validation for reasonable GPS coordinates
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        gpsData.push({
          latitude: lat,
          longitude: lng,
          timestamp: timestamp,
          session: session,
          camera: camera,
          anomalyType: anomalyType,
          recordIndex: index,
          originalRecord: record
        });
      }
    }
  });
  
  return gpsData;
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

// NEW: Get all GPS data from metadata files across all cameras and sessions
app.get('/api/gps-data/metadata', async (req, res) => {
  try {
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    const allGPSData = [];
    const gpsStats = {
      totalFiles: metadataFiles.length,
      filesWithGPS: 0,
      totalGPSPoints: 0,
      sessions: {},
      cameras: {},
      anomalyTypes: {}
    };
    
    for (const file of metadataFiles) {
      try {
        const metadataData = await readCSV(file.path);
        const gpsData = extractGPSData(metadataData, file.session, file.camera, file.anomalyType);
        
        if (gpsData.length > 0) {
          gpsStats.filesWithGPS++;
          gpsStats.totalGPSPoints += gpsData.length;
          
          // Update stats
          if (!gpsStats.sessions[file.session]) gpsStats.sessions[file.session] = 0;
          if (!gpsStats.cameras[file.camera]) gpsStats.cameras[file.camera] = 0;
          if (!gpsStats.anomalyTypes[file.anomalyType]) gpsStats.anomalyTypes[file.anomalyType] = 0;
          
          gpsStats.sessions[file.session] += gpsData.length;
          gpsStats.cameras[file.camera] += gpsData.length;
          gpsStats.anomalyTypes[file.anomalyType] += gpsData.length;
          
          allGPSData.push(...gpsData);
        }
      } catch (error) {
        console.error(`Error processing GPS data from ${file.path}:`, error.message);
      }
    }
    
    // Sort by timestamp if available
    allGPSData.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return new Date(a.timestamp) - new Date(b.timestamp);
      }
      return 0;
    });
    
    res.json({
      success: true,
      count: allGPSData.length,
      data: allGPSData,
      statistics: gpsStats,
      metadata: {
        source: 'All metadata.csv files',
        type: 'GPS data extracted from anomaly detection metadata',
        description: 'GPS coordinates found in metadata files across all cameras and sessions'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to extract GPS data from metadata files'
    });
  }
});

// NEW: Get combined GPS data from both gps_log.csv and metadata files
app.get('/api/gps-data/combined', async (req, res) => {
  try {
    const allGPSData = [];
    const sources = [];
    
    // Get GPS data from F2/gps_log.csv
    try {
      const gpsPath = path.join(DATA_PATH, 'F2', 'gps_log.csv');
      const gpsLogData = await readCSV(gpsPath);
      
      // Convert gps_log format to standardized format
      const standardizedGpsLog = gpsLogData.map((record, index) => ({
        latitude: parseFloat(record.latitude || record.lat),
        longitude: parseFloat(record.longitude || record.lng || record.lon),
        timestamp: record.timestamp || record.time || record.datetime,
        session: 'F2',
        camera: 'gps_logger',
        anomalyType: 'tracking',
        recordIndex: index,
        source: 'gps_log.csv',
        originalRecord: record
      })).filter(point => !isNaN(point.latitude) && !isNaN(point.longitude));
      
      allGPSData.push(...standardizedGpsLog);
      sources.push({
        source: 'F2/gps_log.csv',
        type: 'GPS tracking log',
        count: standardizedGpsLog.length
      });
    } catch (error) {
      console.warn('Could not read GPS log file:', error.message);
    }
    
    // Get GPS data from metadata files
    try {
      const metadataFiles = await scanForMetadataFiles(DATA_PATH);
      let metadataGPSCount = 0;
      
      for (const file of metadataFiles) {
        try {
          const metadataData = await readCSV(file.path);
          const gpsData = extractGPSData(metadataData, file.session, file.camera, file.anomalyType);
          
          if (gpsData.length > 0) {
            // Add source information to each GPS point
            const enhancedGPSData = gpsData.map(point => ({
              ...point,
              source: 'metadata.csv'
            }));
            
            allGPSData.push(...enhancedGPSData);
            metadataGPSCount += gpsData.length;
          }
        } catch (error) {
          console.error(`Error processing ${file.path}:`, error.message);
        }
      }
      
      sources.push({
        source: 'metadata.csv files',
        type: 'GPS from anomaly detection metadata',
        count: metadataGPSCount
      });
    } catch (error) {
      console.warn('Could not extract GPS from metadata files:', error.message);
    }
    
    // Sort all GPS data by timestamp
    allGPSData.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return new Date(a.timestamp) - new Date(b.timestamp);
      }
      return 0;
    });
    
    res.json({
      success: true,
      count: allGPSData.length,
      data: allGPSData,
      sources: sources,
      metadata: {
        type: 'Combined GPS data from all sources',
        description: 'GPS coordinates from both GPS log files and metadata files'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to get combined GPS data'
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

// Get all metadata files information with image counts and GPS data
app.get('/api/metadata/scan', async (req, res) => {
  try {
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    
    // Enhanced scan that includes image and GPS information
    const enhancedFiles = [];
    for (const file of metadataFiles) {
      try {
        // Read metadata to check for GPS data
        const metadataData = await readCSV(file.path);
        const gpsData = extractGPSData(metadataData, file.session, file.camera, file.anomalyType);
        
        // Look for images in the images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        
        enhancedFiles.push({
          session: file.session,
          camera: file.camera,
          anomalyType: file.anomalyType,
          path: file.relativePath,
          recordCount: metadataData.length,
          imageCount: images.length,
          gpsCount: gpsData.length,
          hasImages: images.length > 0,
          hasGPS: gpsData.length > 0,
          sampleImages: images.slice(0, 3).map(img => img.name),
          imagesPath: `${file.session}/${file.camera}/${file.anomalyType}/images/`,
          gpsStats: gpsData.length > 0 ? {
            firstTimestamp: gpsData[0]?.timestamp,
            lastTimestamp: gpsData[gpsData.length - 1]?.timestamp,
            latRange: [
              Math.min(...gpsData.map(p => p.latitude)),
              Math.max(...gpsData.map(p => p.latitude))
            ],
            lngRange: [
              Math.min(...gpsData.map(p => p.longitude)),
              Math.max(...gpsData.map(p => p.longitude))
            ]
          } : null
        });
      } catch (error) {
        console.error(`Error processing ${file.path}:`, error.message);
        enhancedFiles.push({
          session: file.session,
          camera: file.camera,
          anomalyType: file.anomalyType,
          path: file.relativePath,
          recordCount: 0,
          imageCount: 0,
          gpsCount: 0,
          hasImages: false,
          hasGPS: false,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      count: enhancedFiles.length,
      files: enhancedFiles,
      summary: {
        totalFiles: enhancedFiles.length,
        filesWithImages: enhancedFiles.filter(f => f.hasImages).length,
        filesWithGPS: enhancedFiles.filter(f => f.hasGPS).length,
        totalImages: enhancedFiles.reduce((sum, f) => sum + f.imageCount, 0),
        totalGPSPoints: enhancedFiles.reduce((sum, f) => sum + f.gpsCount, 0)
      }
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

// Enhanced metadata endpoint that includes image and GPS information
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
    
    // Extract GPS data from metadata
    const gpsData = extractGPSData(metadataData, session, camera, anomalyType);
    
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
      gps: {
        count: gpsData.length,
        data: gpsData,
        hasGPS: gpsData.length > 0
      },
      source: `${session}/${camera}/${anomalyType}/`
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: `Failed to get metadata, images, and GPS for ${req.params.session}/${req.params.camera}/${req.params.anomalyType}`
    });
  }
});

// Get specific metadata by session, camera, and anomaly type (now includes GPS)
app.get('/api/metadata/:session/:camera/:anomalyType', async (req, res) => {
  try {
    const { session, camera, anomalyType } = req.params;
    const metadataPath = path.join(DATA_PATH, session, camera, anomalyType, 'metadata.csv');
    
    const metadataData = await readCSV(metadataPath);
    const gpsData = extractGPSData(metadataData, session, camera, anomalyType);
    
    res.json({
      success: true,
      count: metadataData.length,
      data: metadataData,
      gps: {
        count: gpsData.length,
        data: gpsData,
        hasGPS: gpsData.length > 0
      },
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

// Get all anomalies for a specific camera across all sessions (now includes GPS)
app.get('/api/camera/:camera/anomalies', async (req, res) => {
  try {
    const { camera } = req.params;
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    const cameraFiles = metadataFiles.filter(file => file.camera === camera);
    
    const anomalies = [];
    for (const file of cameraFiles) {
      try {
        const data = await readCSV(file.path);
        const gpsData = extractGPSData(data, file.session, file.camera, file.anomalyType);
        
        // Look for images in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        
        anomalies.push({
          session: file.session,
          anomalyType: file.anomalyType,
          count: data.length,
          imageCount: images.length,
          gpsCount: gpsData.length,
          data: data,
          gps: gpsData,
          images: images.slice(0, 5), // First 5 images as preview
          hasGPS: gpsData.length > 0
        });
      } catch (error) {
        console.error(`Error reading ${file.path}:`, error.message);
      }
    }
    
    res.json({
      success: true,
      camera,
      anomalyCount: anomalies.length,
      totalGPSPoints: anomalies.reduce((sum, a) => sum + a.gpsCount, 0),
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

// Get dashboard summary with all data including images and GPS
app.get('/api/dashboard', async (req, res) => {
  try {
    const dashboard = {
      success: true,
      timestamp: new Date().toISOString(),
      summary: {}
    };

    // GPS Data from log file
    try {
      const gpsPath = path.join(DATA_PATH, 'F2', 'gps_log.csv');
      const gpsData = await readCSV(gpsPath);
      dashboard.summary.gps = {
        available: true,
        recordCount: gpsData.length,
        lastRecord: gpsData[gpsData.length - 1] || null,
        source: 'gps_log.csv'
      };
    } catch (error) {
      dashboard.summary.gps = { available: false, error: error.message, source: 'gps_log.csv' };
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

    // Anomaly Detection Summary with Images and GPS
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    const anomalySummary = {};
    let totalImages = 0;
    let totalGPSPoints = 0;
    let filesWithGPS = 0;
    
    for (const file of metadataFiles) {
      try {
        const data = await readCSV(file.path);
        const gpsData = extractGPSData(data, file.session, file.camera, file.anomalyType);
        
        // Look for images in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        totalImages += images.length;
        totalGPSPoints += gpsData.length;
        
        if (gpsData.length > 0) filesWithGPS++;
        
        if (!anomalySummary[file.camera]) {
          anomalySummary[file.camera] = {};
        }
        
        anomalySummary[file.camera][file.anomalyType] = {
          session: file.session,
          recordCount: data.length,
          imageCount: images.length,
          gpsCount: gpsData.length,
          hasGPS: gpsData.length > 0,
          lastDetection: data[data.length - 1] || null,
          sampleImages: images.slice(0, 3).map(img => ({
            name: img.name,
            // Images are served from images subdirectory
            url: `/data/${file.session}/${file.camera}/${file.anomalyType}/images/${img.name}`
          })),
          sampleGPS: gpsData.slice(0, 3)
        };
      } catch (error) {
        console.error(`Error processing ${file.path}:`, error.message);
      }
    }
    
    dashboard.summary.anomalies = anomalySummary;
    dashboard.summary.totalMetadataFiles = metadataFiles.length;
    dashboard.summary.totalImages = totalImages;
    dashboard.summary.totalGPSPointsFromMetadata = totalGPSPoints;
    dashboard.summary.filesWithGPS = filesWithGPS;
    dashboard.summary.metadataGPSCoverage = ((filesWithGPS / metadataFiles.length) * 100).toFixed(1) + '%';

    res.json(dashboard);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to generate dashboard'
    });
  }
});

// Get anomalies by type across all cameras (now includes GPS)
app.get('/api/anomalies/:anomalyType', async (req, res) => {
  try {
    const { anomalyType } = req.params;
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    const anomalyFiles = metadataFiles.filter(file => file.anomalyType === anomalyType);
    
    const results = [];
    let totalGPSPoints = 0;
    
    for (const file of anomalyFiles) {
      try {
        const data = await readCSV(file.path);
        const gpsData = extractGPSData(data, file.session, file.camera, file.anomalyType);
        totalGPSPoints += gpsData.length;
        
        // Look for images in images/ subdirectory
        const imagesPath = path.join(path.dirname(file.path), 'images');
        const images = await getImagesInDirectory(imagesPath);
        
        results.push({
          session: file.session,
          camera: file.camera,
          count: data.length,
          imageCount: images.length,
          gpsCount: gpsData.length,
          hasGPS: gpsData.length > 0,
          data: data,
          gps: gpsData,
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
      totalGPSPoints: totalGPSPoints,
      camerasWithGPS: results.filter(r => r.hasGPS).length,
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

// Search functionality (enhanced with GPS data)
app.get('/api/search', async (req, res) => {
  try {
    const { 
      session, 
      camera, 
      anomalyType, 
      startDate, 
      endDate,
      hasGPS,
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
        
        // Extract GPS data
        const gpsData = extractGPSData(data, file.session, file.camera, file.anomalyType);
        
        // Apply GPS filter if specified
        if (hasGPS !== undefined) {
          const hasGPSBool = hasGPS === 'true';
          if (hasGPSBool && gpsData.length === 0) continue;
          if (!hasGPSBool && gpsData.length > 0) continue;
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
          gpsCount: gpsData.length,
          hasGPS: gpsData.length > 0,
          data: data,
          gps: gpsData,
          images: images.slice(0, 5)
        });
      } catch (error) {
        console.error(`Error reading ${file.path}:`, error.message);
      }
    }
    
    res.json({
      success: true,
      filters: { session, camera, anomalyType, startDate, endDate, hasGPS, limit },
      resultCount: results.length,
      totalRecords: results.reduce((sum, r) => sum + r.count, 0),
      totalImages: results.reduce((sum, r) => sum + r.imageCount, 0),
      totalGPSPoints: results.reduce((sum, r) => sum + r.gpsCount, 0),
      resultsWithGPS: results.filter(r => r.hasGPS).length,
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

// NEW: Get GPS data for a specific session/camera/anomaly type
app.get('/api/gps/:session/:camera/:anomalyType', async (req, res) => {
  try {
    const { session, camera, anomalyType } = req.params;
    const metadataPath = path.join(DATA_PATH, session, camera, anomalyType, 'metadata.csv');
    
    const metadataData = await readCSV(metadataPath);
    const gpsData = extractGPSData(metadataData, session, camera, anomalyType);
    
    if (gpsData.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No GPS data found for ${session}/${camera}/${anomalyType}`,
        session,
        camera,
        anomalyType,
        gpsCount: 0
      });
    }
    
    res.json({
      success: true,
      session,
      camera,
      anomalyType,
      count: gpsData.length,
      data: gpsData,
      bounds: {
        latRange: [
          Math.min(...gpsData.map(p => p.latitude)),
          Math.max(...gpsData.map(p => p.latitude))
        ],
        lngRange: [
          Math.min(...gpsData.map(p => p.longitude)),
          Math.max(...gpsData.map(p => p.longitude))
        ]
      },
      metadata: {
        source: `${session}/${camera}/${anomalyType}/metadata.csv`,
        type: 'GPS data extracted from metadata'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: `Failed to get GPS data for ${req.params.session}/${req.params.camera}/${req.params.anomalyType}`
    });
  }
});

// NEW: Get GPS heatmap data for visualization
app.get('/api/gps/heatmap', async (req, res) => {
  try {
    const { session, camera, anomalyType, precision = 4 } = req.query;
    const precisionLevel = parseInt(precision);
    
    let allGPSData = [];
    
    if (session && camera && anomalyType) {
      // Get GPS for specific location
      const metadataPath = path.join(DATA_PATH, session, camera, anomalyType, 'metadata.csv');
      const metadataData = await readCSV(metadataPath);
      allGPSData = extractGPSData(metadataData, session, camera, anomalyType);
    } else {
      // Get all GPS data from metadata files
      const metadataFiles = await scanForMetadataFiles(DATA_PATH);
      
      for (const file of metadataFiles) {
        try {
          if (session && file.session !== session) continue;
          if (camera && file.camera !== camera) continue;
          if (anomalyType && file.anomalyType !== anomalyType) continue;
          
          const metadataData = await readCSV(file.path);
          const gpsData = extractGPSData(metadataData, file.session, file.camera, file.anomalyType);
          allGPSData.push(...gpsData);
        } catch (error) {
          console.error(`Error processing ${file.path}:`, error.message);
        }
      }
    }
    
    // Create heatmap points by rounding coordinates to specified precision
    const heatmapData = {};
    
    allGPSData.forEach(point => {
      const lat = parseFloat(point.latitude.toFixed(precisionLevel));
      const lng = parseFloat(point.longitude.toFixed(precisionLevel));
      const key = `${lat},${lng}`;
      
      if (!heatmapData[key]) {
        heatmapData[key] = {
          latitude: lat,
          longitude: lng,
          count: 0,
          sessions: new Set(),
          cameras: new Set(),
          anomalyTypes: new Set()
        };
      }
      
      heatmapData[key].count++;
      heatmapData[key].sessions.add(point.session);
      heatmapData[key].cameras.add(point.camera);
      heatmapData[key].anomalyTypes.add(point.anomalyType);
    });
    
    // Convert to array and add metadata
    const heatmapPoints = Object.values(heatmapData).map(point => ({
      latitude: point.latitude,
      longitude: point.longitude,
      intensity: point.count,
      sessions: Array.from(point.sessions),
      cameras: Array.from(point.cameras),
      anomalyTypes: Array.from(point.anomalyTypes)
    }));
    
    res.json({
      success: true,
      count: heatmapPoints.length,
      totalPoints: allGPSData.length,
      data: heatmapPoints,
      filters: { session, camera, anomalyType, precision: precisionLevel },
      metadata: {
        type: 'GPS heatmap data',
        description: 'Aggregated GPS points for visualization'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to generate GPS heatmap data'
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
    title: 'Enhanced Surveillance Data API with GPS Support',
    version: '3.0.0',
    endpoints: {
      health: 'GET /health - Health check',
      gps: {
        main: 'GET /api/gps-data - Get GPS tracking data from log file',
        metadata: 'GET /api/gps-data/metadata - Get GPS data extracted from all metadata files',
        combined: 'GET /api/gps-data/combined - Get combined GPS data from all sources',
        specific: 'GET /api/gps/:session/:camera/:anomalyType - Get GPS data for specific camera/class',
        heatmap: 'GET /api/gps/heatmap?session=&camera=&anomalyType=&precision=4 - Get GPS heatmap data'
      },
      systemMetrics: 'GET /api/system-metrics - Get system performance metrics',
      metadataScan: 'GET /api/metadata/scan - Scan for all metadata files (with image and GPS counts)',
      specificMetadata: 'GET /api/metadata/:session/:camera/:anomalyType - Get specific metadata (with GPS)',
      imagesList: 'GET /api/images/:session/:camera/:anomalyType - Get images for specific camera/class',
      metadataWithImages: 'GET /api/metadata-with-images/:session/:camera/:anomalyType - Get metadata, images, and GPS together',
      cameraAnomalies: 'GET /api/camera/:camera/anomalies - Get all anomalies for a camera (with images and GPS)',
      anomaliesByType: 'GET /api/anomalies/:anomalyType - Get anomalies by type (with images and GPS)',
      dashboard: 'GET /api/dashboard - Get complete dashboard summary (with image and GPS info)',
      search: 'GET /api/search?hasGPS=true&... - Search with filters (includes GPS data and counts)',
      staticFiles: 'GET /data/... - Static file access (IMAGES SERVED HERE)',
      directoryListing: 'GET /list/... - Directory listing (with image flags)'
    },
    gpsFeatures: {
      extraction: 'Automatically extracts GPS coordinates from metadata.csv files',
      fieldDetection: 'Detects common GPS field names (latitude/lat/gps_lat, longitude/lng/lon/gps_lng)',
      validation: 'Validates GPS coordinates for reasonable ranges (-90 to 90 lat, -180 to 180 lng)',
      aggregation: 'Combines GPS data from multiple sources for comprehensive tracking',
      heatmap: 'Provides aggregated GPS data for heatmap visualization',
      filtering: 'Supports filtering by GPS availability in search queries'
    },
    dataStructure: {
      sessions: ['F2', 'floMobility123_F1'],
      cameras: {
        F2: ['4kcam', 'cam1'],
        floMobility123_F1: ['argus0', 'argus1', 'cam1']
      },
      anomalyTypes: 'Dynamic - scanned from directory structure',
      mainDataFiles: ['F2/gps_log.csv', 'floMobility123_F1/system_metrics.csv'],
      imageAccess: 'GET /data/{session}/{camera}/{anomalyType}/images/{image.jpg}',
      gpsAccess: 'GPS data extracted from metadata.csv files and available via dedicated endpoints'
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
  console.log(`🚀 Enhanced Surveillance Data Server with GPS Support running on http://localhost:${PORT}`);
  console.log(`📁 Serving data from: ${DATA_PATH}`);
  console.log(`🖼️  Images accessible at: http://localhost:${PORT}/data/{session}/{camera}/{class}/images/{image.jpg}`);
  console.log(`🌐 CORS enabled for all origins`);
  console.log(`\n📊 API Endpoints:`);
  console.log(`  - API Documentation: http://localhost:${PORT}/api`);
  console.log(`  - Health check: http://localhost:${PORT}/health`);
  console.log(`  - Dashboard: http://localhost:${PORT}/api/dashboard`);
  console.log(`  - GPS Data (log): http://localhost:${PORT}/api/gps-data`);
  console.log(`  - GPS Data (metadata): http://localhost:${PORT}/api/gps-data/metadata`);
  console.log(`  - GPS Data (combined): http://localhost:${PORT}/api/gps-data/combined`);
  console.log(`  - GPS Heatmap: http://localhost:${PORT}/api/gps/heatmap`);
  console.log(`  - System Metrics: http://localhost:${PORT}/api/system-metrics`);
  console.log(`  - Metadata Scan: http://localhost:${PORT}/api/metadata/scan`);
  console.log(`  - Images API: http://localhost:${PORT}/api/images/{session}/{camera}/{class}`);
  console.log(`  - Search (with GPS): http://localhost:${PORT}/api/search?hasGPS=true`);
  
  // Check if data directory exists
  try {
    await fs.access(DATA_PATH);
    console.log(`\n✅ Data directory found: ${DATA_PATH}`);
    
    // Perform comprehensive scan for all metadata files
    console.log(`\n🔍 Scanning for all metadata.csv files and GPS data...`);
    const metadataFiles = await scanForMetadataFiles(DATA_PATH);
    console.log(`📋 Found ${metadataFiles.length} metadata.csv files`);
    
    if (metadataFiles.length > 0) {
      // Group by session and camera for better logging
      const grouped = {};
      let totalImages = 0;
      let totalGPSPoints = 0;
      let filesWithGPS = 0;
      
      for (const file of metadataFiles) {
        if (!grouped[file.session]) grouped[file.session] = {};
        if (!grouped[file.session][file.camera]) grouped[file.session][file.camera] = [];
        
        try {
          // Read metadata and extract GPS
          const metadataData = await readCSV(file.path);
          const gpsData = extractGPSData(metadataData, file.session, file.camera, file.anomalyType);
          
          // Count images in images/ subdirectory
          const imagesPath = path.join(path.dirname(file.path), 'images');
          const images = await getImagesInDirectory(imagesPath);
          totalImages += images.length;
          totalGPSPoints += gpsData.length;
          
          if (gpsData.length > 0) filesWithGPS++;
          
          grouped[file.session][file.camera].push({
            anomalyType: file.anomalyType,
            imageCount: images.length,
            gpsCount: gpsData.length,
            hasGPS: gpsData.length > 0
          });
        } catch (error) {
          console.error(`Error processing ${file.path}:`, error.message);
          grouped[file.session][file.camera].push({
            anomalyType: file.anomalyType,
            imageCount: 0,
            gpsCount: 0,
            hasGPS: false,
            error: true
          });
        }
      }
      
      console.log(`\n📸 Complete Camera Structure with GPS Info:`);
      Object.keys(grouped).forEach(session => {
        console.log(`  📁 Session: ${session}`);
        Object.keys(grouped[session]).forEach(camera => {
          const classes = grouped[session][camera];
          const totalClassImages = classes.reduce((sum, c) => sum + c.imageCount, 0);
          const totalClassGPS = classes.reduce((sum, c) => sum + c.gpsCount, 0);
          const classesWithGPS = classes.filter(c => c.hasGPS).length;
          
          console.log(`    📷 ${camera}: ${classes.length} classes, ${totalClassImages} images, ${totalClassGPS} GPS points`);
          classes.forEach(c => {
            const gpsStatus = c.hasGPS ? `✅ ${c.gpsCount} GPS` : '❌ No GPS';
            console.log(`      - ${c.anomalyType}: ${c.imageCount} images, ${gpsStatus}`);
          });
        });
      });
      
      // Log unique cameras and anomaly types
      const uniqueCameras = [...new Set(metadataFiles.map(f => f.camera))];
      const uniqueAnomalyTypes = [...new Set(metadataFiles.map(f => f.anomalyType))];
      
      console.log(`\n📊 Enhanced Summary:`);
      console.log(`  🎥 Total Cameras: ${uniqueCameras.length} (${uniqueCameras.join(', ')})`);
      console.log(`  🔍 Total Anomaly Types: ${uniqueAnomalyTypes.length} (${uniqueAnomalyTypes.join(', ')})`);
      console.log(`  📁 Total Sessions: ${Object.keys(grouped).length}`);
      console.log(`  🖼️  Total Images: ${totalImages}`);
      console.log(`  📍 Total GPS Points (from metadata): ${totalGPSPoints}`);
      console.log(`  📊 Files with GPS: ${filesWithGPS}/${metadataFiles.length} (${((filesWithGPS/metadataFiles.length)*100).toFixed(1)}%)`);
    }
    
    // Check for main data files including GPS log
    const mainFiles = ['F2/gps_log.csv', 'floMobility123_F1/system_metrics.csv'];
    console.log(`\n📄 Checking main data files:`);
    for (const file of mainFiles) {
      try {
        await fs.access(path.join(DATA_PATH, file));
        console.log(`  ✅ Found: ${file}`);
        
        // Check GPS log file for additional GPS data
        if (file === 'F2/gps_log.csv') {
          try {
            const gpsLogData = await readCSV(path.join(DATA_PATH, file));
            console.log(`    📍 Contains ${gpsLogData.length} GPS tracking records`);
          } catch (error) {
            console.log(`    ⚠️  Error reading GPS log: ${error.message}`);
          }
        }
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
  console.log('\n👋 Shutting down enhanced surveillance server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down enhanced surveillance server...');
  process.exit(0);
});