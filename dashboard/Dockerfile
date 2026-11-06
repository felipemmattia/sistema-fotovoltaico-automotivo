# Production Dockerfile for Solar Photovoltaic Telemetry Dashboard
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY backend/package*.json ./backend/

# Install dependencies
RUN cd backend && npm install --production

# Copy application source code
COPY backend ./backend
COPY frontend ./frontend

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

WORKDIR /app/backend

CMD ["node", "server.js"]
