FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /sv .

FROM scratch
COPY --from=build /sv /sv
EXPOSE 8088
ENTRYPOINT ["/sv"]
