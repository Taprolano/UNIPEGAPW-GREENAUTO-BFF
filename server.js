const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const winston = require('winston');

const app = express();
const PORT = 3001;

// Configure Winston logger
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, stack }) => {
        return `${timestamp} [${level}]: ${stack || message}`;
      })
  ),
  defaultMeta: { service: 'greenautom-esg-api' },
  transports: [
    // Console output
    new winston.transports.Console({
      format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
      )
    }),
    // Error log file
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
      )
    }),
    // Combined log file
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
      )
    })
  ]
});

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Request logging middleware
const requestLogger = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const logLevel = res.statusCode >= 400 ? 'warn' : 'info';

    logger.log(logLevel, `${req.method} ${req.originalUrl}`, {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
  });

  next();
};

// Middleware - order matters!
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use(requestLogger);

/**
 * Helper function to read JSON files from data directory
 * @param {string} filename - Name of the JSON file to read
 * @returns {Object|null} Parsed JSON data or null if error
 */
const readJsonFile = (filename) => {
  try {
    const filePath = path.join(__dirname, 'data', filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      logger.error(`File not found: ${filePath}`);
      return null;
    }

    const data = fs.readFileSync(filePath, 'utf8');

    // Validate that we have data
    if (!data || data.trim() === '') {
      logger.error(`Empty file: ${filename}`);
      return null;
    }

    // Parse JSON with error handling
    try {
      const parsedData = JSON.parse(data);
      logger.debug(`Successfully read ${filename}`, {
        recordCount: Array.isArray(parsedData) ? parsedData.length : 'single object'
      });
      return parsedData;
    } catch (parseError) {
      logger.error(`JSON parse error in ${filename}`, {
        error: parseError.message,
        preview: data.substring(0, 200)
      });
      return null;
    }

  } catch (error) {
    logger.error(`Error reading ${filename}`, { error: error.message });
    return null;
  }
};

/**
 * Helper function to validate year parameter
 * @param {string} year - Year string to validate
 * @returns {number|null} Valid year number or null
 */
const validateYear = (year) => {
  const yearNum = parseInt(year);

  // Allow years from 2020 to 2025 only
  if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2025) {
    logger.debug(`Invalid year parameter: ${year}`);
    return null;
  }

  return yearNum;
};

/**
 * Get company statistics for a specific year
 * Used by: Overview tab year picker
 */
app.get('/api/esg/company-stats/:year', (req, res) => {
  const { year } = req.params;

  logger.info(`Company stats requested for year: ${year}`);

  const validYear = validateYear(year);

  if (!validYear) {
    logger.warn(`Invalid year parameter: ${year}`);
    return res.status(400).json({
      success: false,
      error: 'Invalid year parameter',
      timestamp: new Date().toISOString()
    });
  }

  const stats = readJsonFile('company-stats.json');

  if (!stats) {
    logger.error('Failed to read company-stats.json');
    return res.status(500).json({
      success: false,
      error: 'Failed to load company stats data',
      timestamp: new Date().toISOString()
    });
  }

  logger.debug(`Loaded ${stats.length} company stats records`);

  const yearData = stats.find(item => item.year === validYear);

  if (!yearData) {
    const availableYears = stats.map(s => s.year);
    logger.warn(`No company stats found for year ${validYear}`, {
      requestedYear: validYear,
      availableYears
    });

    return res.status(404).json({
      success: false,
      error: `No company stats found for year ${validYear}`,
      year: validYear,
      timestamp: new Date().toISOString()
    });
  }

  logger.info(`Successfully retrieved company stats for year ${validYear}`, {
    year: validYear,
    dataFields: Object.keys(yearData)
  });

  res.json({
    success: true,
    data: yearData,
    year: validYear,
    timestamp: new Date().toISOString()
  });
});

/**
 * Get all emissions data
 * Used by: Initial data loading
 */
app.get('/api/esg/emissions', (req, res) => {
  logger.info('Emissions data requested');

  const data = readJsonFile('emissions.json');

  if (!data) {
    logger.error('Failed to load emissions data');
    return res.status(500).json({
      success: false,
      error: 'Failed to load emissions data',
      timestamp: new Date().toISOString()
    });
  }

  logger.info(`Successfully retrieved ${data.length} emissions records`);

  res.json({
    success: true,
    data: data,
    timestamp: new Date().toISOString()
  });
});

/**
 * Get all reports or filter by year
 * Used by: Initial reports loading
 */
app.get('/api/esg/reports', (req, res) => {
  const { year } = req.query;

  logger.info('Reports requested', { yearFilter: year || 'none' });

  const data = readJsonFile('reports.json');

  if (!data) {
    logger.error('Failed to load reports data');
    return res.status(500).json({
      success: false,
      error: 'Failed to load reports data',
      timestamp: new Date().toISOString()
    });
  }

  let filteredData = data;

  // Filter by year if specified and not 0 (0 means "All Years")
  if (year && year !== '0') {
    const validYear = validateYear(year);

    if (!validYear) {
      logger.warn(`Invalid year parameter in reports request: ${year}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid year parameter',
        timestamp: new Date().toISOString()
      });
    }

    filteredData = data.filter(report => report.year === validYear);

    // Check if no reports found for the year
    if (filteredData.length === 0) {
      logger.warn(`No reports found for year ${validYear}`);
      return res.status(404).json({
        success: false,
        error: `No reports found for year ${validYear}`,
        message: `Reports for ${validYear} may still be in preparation or not yet published`,
        year: validYear,
        timestamp: new Date().toISOString()
      });
    }

    logger.info(`Filtered reports by year ${validYear}`, {
      totalReports: data.length,
      filteredCount: filteredData.length
    });
  } else {
    logger.info(`Retrieved all reports`, { count: filteredData.length });
  }

  res.json({
    success: true,
    data: filteredData,
    count: filteredData.length,
    year: year && year !== '0' ? parseInt(year) : null,
    timestamp: new Date().toISOString()
  });
});

/**
 * Advanced search functionality for reports
 * Used by: Reports tab search, year filter, category filter
 */
app.get('/api/esg/reports/search', (req, res) => {
  const { q, year, category } = req.query;

  logger.info('Reports search requested', {
    searchTerm: q || 'none',
    yearFilter: year || 'none',
    categoryFilter: category || 'none'
  });

  const reports = readJsonFile('reports.json');

  if (!reports) {
    logger.error('Failed to load reports data for search');
    return res.status(500).json({
      success: false,
      error: 'Failed to load reports data',
      timestamp: new Date().toISOString()
    });
  }

  let filtered = reports;
  const initialCount = reports.length;

  // Filter by search term
  if (q && q.trim() !== '') {
    const searchTerm = q.toLowerCase().trim();
    filtered = filtered.filter(report =>
        report.title.toLowerCase().includes(searchTerm) ||
        report.category.toLowerCase().includes(searchTerm) ||
        (report.description && report.description.toLowerCase().includes(searchTerm))
    );
    logger.debug(`Applied search filter`, {
      searchTerm,
      beforeCount: initialCount,
      afterCount: filtered.length
    });
  }

  // Filter by year (skip if year is 0 which means "All Years")
  if (year && year !== '0') {
    const validYear = validateYear(year);
    if (validYear) {
      const beforeYearFilter = filtered.length;
      filtered = filtered.filter(report => report.year === validYear);
      logger.debug(`Applied year filter`, {
        year: validYear,
        beforeCount: beforeYearFilter,
        afterCount: filtered.length
      });
    }
  }

  // Filter by category
  if (category && category.trim() !== '') {
    const categoryFilter = category.toLowerCase().trim();
    const beforeCategoryFilter = filtered.length;
    filtered = filtered.filter(report =>
        report.category.toLowerCase().includes(categoryFilter)
    );
    logger.debug(`Applied category filter`, {
      category: categoryFilter,
      beforeCount: beforeCategoryFilter,
      afterCount: filtered.length
    });
  }

  logger.info(`Search completed`, {
    totalResults: filtered.length,
    filtersApplied: {
      search: !!q,
      year: !!(year && year !== '0'),
      category: !!category
    }
  });

  res.json({
    success: true,
    data: filtered,
    count: filtered.length,
    filters: {
      search: q || null,
      year: year && year !== '0' ? parseInt(year) : null,
      category: category || null
    },
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  logger.info('Health check requested');

  res.json({
    status: 'live',
    message: 'GreenAuto ESG API is running',
    version: '1.0.0',
    endpoints: {
      companyStats: '/api/esg/company-stats/:year',
      emissions: '/api/esg/emissions',
      reports: '/api/esg/reports',
      reportsSearch: '/api/esg/reports/search'
    },
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled server error', {
    error: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  logger.warn('Endpoint not found', {
    path: req.originalUrl,
    method: req.method,
    ip: req.ip
  });

  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  logger.info('GreenAuto ESG API started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    logLevel: logger.level
  });
  logger.info(`API Documentation available at http://localhost:${PORT}/api/health`);
});
