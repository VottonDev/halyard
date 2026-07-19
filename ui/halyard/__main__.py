"""Package entry point, so `python3 -m halyard` works.

Without this, only `python3 -m halyard.main` runs the app, which is a
surprising thing to require and is not what the installed launcher calls.
"""

import sys

from .main import main

if __name__ == "__main__":
    sys.exit(main())
