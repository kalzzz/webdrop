.PHONY: build run clean

build:
	go build -o webdrop .

run: build
	./webdrop

clean:
	rm -f webdrop
