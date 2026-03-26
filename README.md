# GPX Route Viewer (Static Site)

A static web page that renders multiple GPX files on top of OpenStreetMap using Leaflet.

## Features

- Upload one or many `.gpx` files from the browser.
- Draw each file in a different color.
- Automatically zoom map to fit all loaded routes.
- Per-file actions: center, hide/show, and delete.
- Group loaded files by start location (reverse geocoding with coordinate fallback).
- Clear all rendered tracks with one click.
- Quiet or street basemap toggle.

## Files

- `index.html`: page structure and map container.
- `style.css`: layout and visual styling.
- `app.js`: GPX parsing and map rendering logic.
