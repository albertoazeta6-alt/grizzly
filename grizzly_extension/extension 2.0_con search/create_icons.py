#!/usr/bin/env python3
# Genera le icone per l'estensione Chrome
# Lancia con: python3 create_icons.py

import base64

# Icona SVG Grizzly (orso stilizzato)
svg = '''<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="48" height="48" rx="10" fill="#0a0c0f"/>
  <circle cx="18" cy="16" r="4" fill="#f59e0b"/>
  <circle cx="30" cy="16" r="4" fill="#f59e0b"/>
  <ellipse cx="24" cy="28" rx="12" ry="10" fill="#f59e0b"/>
  <ellipse cx="24" cy="28" rx="8" ry="7" fill="#d97706"/>
  <circle cx="21" cy="26" r="1.5" fill="#0a0c0f"/>
  <circle cx="27" cy="26" r="1.5" fill="#0a0c0f"/>
  <ellipse cx="24" cy="30" rx="3" ry="2" fill="#0a0c0f"/>
</svg>'''

print("Icone SVG pronte.")
print("Per generare i PNG, usa un tool online come:")
print("https://cloudconvert.com/svg-to-png")
print()
print("Oppure installa: pip install cairosvg")
print("Poi lancia: python3 -c \"import cairosvg; cairosvg.svg2png(url='icon.svg', write_to='icon48.png', output_width=48, output_height=48)\"")
print()
print("SVG content:")
print(svg)

# Salva l'SVG
with open('icon.svg', 'w') as f:
    f.write(svg)
print()
print("Salvato icon.svg")
