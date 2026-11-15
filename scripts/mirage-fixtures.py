"""Deterministic UI-like raster fixtures; not browser screenshots."""
import base64, json
from PIL import Image, ImageDraw, ImageFont
cases = [
 ('dialog', ['Confirm changes', 'Cancel', 'Save'], 28, 'white', 'black'),
 ('success', ['Changes saved', 'Continue'], 28, 'white', 'black'),
 ('error', ['Payment failed', 'Try again'], 28, 'white', 'black'),
 ('loading', ['Loading', 'Please wait'], 28, 'white', 'black'),
 ('dense', ['Account settings', 'Email address', 'Display name', 'Notifications', 'Cancel', 'Save changes'], 16, 'white', 'black'),
 ('dark', ['Delete account', 'Cancel', 'Delete'], 24, '#202020', 'white'),
 ('low-contrast', ['Session expired', 'Sign in'], 20, 'white', '#cccccc'),
 ('blank', [], 24, 'white', 'black'),
 ('tiny', ['Account settings', 'Payment failed', 'Try again', 'Cancel'], 9, 'white', 'black'),
 ('small-disabled', ['Changes saved', 'Continue', 'Cancel'], 12, 'white', '#dddddd'),
 ('identifiers', ['Order ZX9Q-731B', 'Amount $104.50', 'Submit order'], 18, 'white', 'black'),
 ('rotated', ['Confirm changes', 'Cancel', 'Save'], 24, 'white', 'black'),
]
result=[]
for name, labels, size, background, foreground in cases:
    img=Image.new('RGB',(640,480),background); draw=ImageDraw.Draw(img)
    font=ImageFont.truetype('DejaVuSans.ttf',size)
    for i,label in enumerate(labels):
        y=35+i*60
        if i==len(labels)-1:
            draw.rounded_rectangle((22,y-6,360,y+size+14),radius=6,outline=foreground,width=2)
        draw.text((32,y),label,font=font,fill=foreground)
    if name == 'rotated': img=img.rotate(12,fillcolor='white')
    result.append(dict(name=name,width=640,height=480,expected=labels,rgb=base64.b64encode(img.tobytes()).decode()))
print(json.dumps(result))
