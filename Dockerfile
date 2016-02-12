FROM node:0.10

WORKDIR /app

COPY package.json /app/package.json
RUN npm install

COPY . /app
