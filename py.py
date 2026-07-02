import sqlite3
conn = sqlite3.connect('etube.db')


#droptable
cursor = conn.cursor()
cursor.execute("DROP TABLE IF EXISTS comments")
cursor.execute("DROP TABLE IF EXISTS local_videos")
