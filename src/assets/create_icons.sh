#!/bin/bash
# Create placeholder PNG icons using ImageMagick

# Check if convert command is available
if ! command -v convert &> /dev/null; then
    echo "ImageMagick not found, trying with Python PIL"
    python3 << 'PYTHON_EOF'
from PIL import Image, ImageDraw, ImageFont
import os

def create_icon(size, filename):
    # Create a gradient background
    img = Image.new('RGB', (size, size), color='#667eea')
    draw = ImageDraw.Draw(img)
    
    # Draw a simple "S3" text
    try:
        font_size = size // 2
        # Try to use a default font, fallback if not available
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except:
        font = ImageFont.load_default()
    
    text = "S3"
    # Get text bounding box
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    
    # Center the text
    x = (size - text_width) // 2
    y = (size - text_height) // 2
    
    # Draw white text
    draw.text((x, y), text, fill='white', font=font)
    
    # Save the image
    img.save(filename)
    print(f"Created {filename}")

# Create icons
create_icon(16, 'icon16.png')
create_icon(48, 'icon48.png')
create_icon(128, 'icon128.png')

print("All icons created successfully!")
PYTHON_EOF
else
    # Create icons using ImageMagick
    convert -size 16x16 xc:#667eea -font DejaVu-Sans-Bold -pointsize 8 -fill white -gravity center -annotate +0+0 "S3" icon16.png
    convert -size 48x48 xc:#667eea -font DejaVu-Sans-Bold -pointsize 24 -fill white -gravity center -annotate +0+0 "S3" icon48.png
    convert -size 128x128 xc:#667eea -font DejaVu-Sans-Bold -pointsize 64 -fill white -gravity center -annotate +0+0 "S3" icon128.png
    echo "All icons created successfully using ImageMagick!"
fi
